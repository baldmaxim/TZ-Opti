'use strict';

// Стадия 1 — LLM-агент: ТЗ vs ВОР/чек-лист (что ГП не выполняет по объёму).
// Generic-каркас (сегментация/locate/весь-пункт/дедуп/раннер) — в
// shared/llmStage.js. Здесь только Stage-1-специфика: подготовка ВОР и
// чек-листа, пакеты ВОР, сведение проходов, схема и сборка user-сообщения.
//
// ВОР приходит СТРУКТУРНЫМ (services/vor): позиции с номером, шифром, разделом,
// единицей, количеством и координатами ячеек — вместо прежнего «самая длинная
// ячейка строки». Большой ВОР больше НЕ выбрасывается по лимиту символов: под
// каждую часть ТЗ отбираются релевантные позиции, а если и они не влезают —
// ведомость показывается ПАКЕТАМИ (несколько проходов на одну часть ТЗ), и
// «работы нет в ВОР» принимается только по ПЕРЕСЕЧЕНИЮ всех пакетов.
//
// Контракт: (context{ sourceDocumentId, blocks, vorItems, vorText, checklist }) → Issue[]

const { getModel } = require('./llm/openaiClient');
const { buildSystemPrompt, resolveVariant } = require('./stage1Prompts');
const {
  renderSegment,
  runLlmStage,
  buildIssue,
  locateInBlocks,
} = require('./shared/llmStage');
const { ALL_ACTIONS } = require('../analysis/actions');
const {
  buildCatalog,
  buildCatalogFromText,
  packCatalog,
  renderBatch,
  catalogStats,
} = require('../vor/vorCatalog');
const { buildMatchIndex, selectCandidates, crossReference } = require('../vor/vorMatchIndex');

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        // Ослаблено (C6): обязателен только fragment (нужен для локализации
        // пункта в ТЗ); остальные поля проставит/нормализует сервер в buildIssue,
        // а бридж отдаёт best-effort при неидеальном JSON. additionalProperties
        // разрешены — лишнее поле модели не теряет находку. Промт (SHARED) всё
        // равно просит заполнить все поля — это лишь снимает жёсткость валидации.
        additionalProperties: true,
        required: ['fragment'],
        properties: {
          fragment: {
            type: 'string',
            description: 'Дословная цитата из ТЗ (несколько слов или короткое предложение).',
          },
          section_path: {
            type: 'string',
            description: 'Путь заголовков, например: "1. Введение › 1.2 Объём работ". Пустая строка, если фрагмент вне заголовка.',
          },
          problem_type: {
            type: 'string',
            enum: ['не_учтено_в_кп', 'не_учтено_в_вор', 'не_в_обоих', 'статус_не_определён'],
          },
          criticality: {
            type: 'string',
            enum: ['high', 'medium', 'low'],
          },
          suggested_action: {
            type: 'string',
            enum: ALL_ACTIONS,
            description: 'Рекомендация агента; инженер может выбрать своё действие в UI.',
          },
          suggested_redaction: {
            type: 'string',
            description: 'Если suggested_action=replace — текст замены. Иначе пустая строка.',
          },
          review_comment: {
            type: 'string',
            description: 'Краткий комментарий инженеру (на русском). Может быть пустым.',
          },
          basis: {
            type: 'string',
            description: 'Краткое обоснование, почему это проблема.',
          },
          confidence: {
            type: 'number',
            minimum: 0,
            maximum: 1,
          },
        },
      },
    },
  },
  required: ['findings'],
};

function formatChecklist(checklist) {
  if (!checklist || !checklist.length) return '(чек-лист пуст)';
  const lines = ['| # | Работа | in_calc |', '|---|---|---|'];
  checklist.forEach((row, i) => {
    const work = (row.work_name || '').replace(/\|/g, '/');
    const inCalc = row.in_calc === 1 ? '1 (учтена в КП)'
      : row.in_calc === 0 ? '0 (НЕ учтена)'
        : 'null (статус не определён)';
    lines.push(`| ${i + 1} | ${work} | ${inCalc} |`);
  });
  return lines.join('\n');
}

// Готовый факт для модели: работа в объёме ГП по чек-листу, но в ведомости её
// нет (или наоборот). Считается детерминированно — не догадкой модели.
function formatCrossReference(cross) {
  if (!cross || !cross.checklist_total || !cross.vor_total) return '';
  const lines = [
    `Сверка чек-лист ↔ ВОР (машинная, по совпадению наименований): ` +
      `${cross.matched} из ${cross.checklist_total} работ чек-листа нашлись в ВОР.`,
  ];
  if (cross.in_calc_without_vor.length) {
    lines.push(
      'Работы, которые ГП выполняет по чек-листу (in_calc=1), но в ВОР не найдены ' +
        '(кандидаты на problem_type=не_учтено_в_вор, если ТЗ их требует):',
    );
    for (const name of cross.in_calc_without_vor.slice(0, 40)) lines.push(`• ${name}`);
    if (cross.in_calc_without_vor.length > 40) {
      lines.push(`• …ещё ${cross.in_calc_without_vor.length - 40}`);
    }
  }
  return lines.join('\n');
}

// ── Бюджеты ──────────────────────────────────────────────────────────────────
// Символьный бюджет стадии — «что влезет в контекст»; токенный бюджет пакета
// ВОР — «сколько ведомости показываем модели за один проход».
const CHAR_BUDGET = Number(process.env.STAGE1_CHAR_BUDGET) || 400000;
const CONCURRENCY = Math.max(1, Number(process.env.STAGE1_CONCURRENCY) || 1);
const SCAFFOLD_OVERHEAD = 600;
const VOR_BATCH_TOKENS = Number(process.env.STAGE1_VOR_BATCH_TOKENS) || 6000;
// Потолок числа пакетов ВОР на одну часть ТЗ. Проходы перемножаются с частями
// ТЗ, поэтому предел нужен; превышение — не «ВОР пропущен», а честная пометка
// в analysisNote о том, сколько позиций показано.
const VOR_MAX_BATCHES = Math.max(1, Number(process.env.STAGE1_VOR_MAX_BATCHES) || 4);

function buildSegmentUserMessage({ tzText, vorText, checklist, crossText, partIdx, partTotal }) {
  const vor = vorText && vorText.trim() ? vorText : '(ВОР не загружен или пуст)';
  const partNote =
    partTotal > 1
      ? `## ТЗ — часть ${partIdx}/${partTotal} (markdown)\n\nЭто ФРАГМЕНТ ТЗ. Анализируй только приведённый ниже текст; остальные части ТЗ обрабатываются отдельно.`
      : '## ТЗ (markdown)';
  return [
    partNote,
    '',
    tzText && tzText.trim() ? tzText : '(пусто)',
    '',
    '---',
    '## ВОР (ведомость объёмов работ)',
    '',
    vor,
    '',
    '---',
    '## Чек-лист работ компании',
    '',
    formatChecklist(checklist),
    ...(crossText ? ['', '---', '## Машинная сверка чек-лист ↔ ВОР', '', crossText] : []),
    '',
    '---',
    'Найди в приведённой части ТЗ фрагменты, описывающие работы, не учтённые в ВОР и в чек-листе как in_calc=1.',
    'Верни их списком в JSON по схеме (поле findings).',
  ].join('\n');
}

// ── Сведение проходов (пакетов ВОР) ──────────────────────────────────────────
// Каждый проход видел ОДНУ часть ведомости, поэтому «работы нет в ВОР» верно
// только тогда, когда её не нашёл НИ ОДИН проход: берём ПЕРЕСЕЧЕНИЕ находок.
// Иначе позиция, лежащая в пакете №2, всё равно была бы объявлена пропущенной
// проходом по пакету №1 — ровно та ошибка, ради которой пакеты и вводились.
const fragmentKey = (f) => String((f && f.fragment) || '').replace(/\s+/g, ' ').trim().toLowerCase();

const CRIT_ORDER = { low: 0, medium: 1, high: 2, critical: 3 };
function strongerCriticality(a, b) {
  const ai = CRIT_ORDER[String(a || '').toLowerCase()];
  const bi = CRIT_ORDER[String(b || '').toLowerCase()];
  if (ai === undefined) return b;
  if (bi === undefined) return a;
  return ai >= bi ? a : b;
}

function intersectPasses(lists) {
  const arrays = (lists || []).map((l) => (Array.isArray(l) ? l : []));
  if (!arrays.length) return [];
  if (arrays.length === 1) return arrays[0];

  const first = new Map();
  for (const f of arrays[0]) {
    const key = fragmentKey(f);
    if (!key || first.has(key)) continue;
    first.set(key, { ...f, vor_batches_confirmed: 1 });
  }
  for (let i = 1; i < arrays.length; i += 1) {
    const seen = new Map();
    for (const f of arrays[i]) {
      const key = fragmentKey(f);
      if (key) seen.set(key, f);
    }
    for (const [key, merged] of [...first]) {
      const other = seen.get(key);
      if (!other) {
        first.delete(key); // этот пакет ВОР работу нашёл → это не пробел покрытия
        continue;
      }
      merged.vor_batches_confirmed += 1;
      merged.criticality = strongerCriticality(merged.criticality, other.criticality);
      if (typeof other.confidence === 'number' && typeof merged.confidence === 'number') {
        merged.confidence = Math.min(merged.confidence, other.confidence);
      }
    }
  }
  return [...first.values()];
}

// ── Подготовка ВОР ───────────────────────────────────────────────────────────
// Структурные позиции (vor_items) — основной путь. Текстовый ВОР (pdf/docx или
// файл, который не удалось разобрать) — строки как есть, без угадывания колонок.
function prepareVorCatalog(ctx) {
  const items = Array.isArray(ctx.vorItems) ? ctx.vorItems : [];
  if (items.length) {
    return { entries: buildCatalog(items), source: 'structured', sourceNote: null };
  }
  const text = ctx.vorText || '';
  if (text.trim()) {
    return {
      entries: buildCatalogFromText(text),
      source: 'text',
      sourceNote:
        'ВОР загружен не таблицей (или таблица не разобрана): позиции показаны строками ' +
        'исходного файла, без единиц и количеств.',
    };
  }
  return { entries: [], source: 'none', sourceNote: null };
}

async function runStage1Llm(context) {
  const { blocks, checklist } = context;

  if (!Array.isArray(blocks) || !blocks.length) {
    const err = new Error('ТЗ.md пуст или не парсится. Загрузите корректный .md в слот ТЗ.');
    err.status = 400;
    throw err;
  }

  const promptVariant = resolveVariant();
  const systemMsg = buildSystemPrompt(promptVariant);
  const cl = checklist || [];
  const clText = formatChecklist(cl);

  const { entries, source, sourceNote } = prepareVorCatalog(context);
  const stats = catalogStats(entries);
  const index = buildMatchIndex({ vorEntries: entries, checklist: cl });
  const cross = entries.length && cl.length ? crossReference(index) : null;
  const crossText = formatCrossReference(cross);

  // eslint-disable-next-line no-console
  console.log(
    `[stage1_llm] model=${getModel()} promptVariant=${promptVariant} ` +
      `ВОР(${source}): позиций ${stats.positions} → записей каталога ${stats.entries} ` +
      `(${stats.tokens}т, единиц ${stats.units.length}); чек-лист ${cl.length}` +
      (cross ? `; сверка чек-лист↔ВОР: ${cross.matched}/${cross.checklist_total}, in_calc без ВОР ${cross.in_calc_without_vor.length}` : ''),
  );

  const notes = [];
  if (source === 'none') {
    notes.push('ВОР не загружен: стадия свела ТЗ только с чек-листом компании.');
  } else if (source === 'text') {
    notes.push(sourceNote);
  }

  const overhead = clText.length + crossText.length + SCAFFOLD_OVERHEAD + systemMsg.length;
  const tzBudget = CHAR_BUDGET - overhead;
  if (tzBudget <= 0) {
    const err = new Error(
      'Чек-лист сам по себе превышает бюджет контекста — ТЗ не влезает. ' +
        'Нужно сократить чек-лист (отдельная задача).',
    );
    err.status = 400;
    throw err;
  }

  // Статистика отбора/пакетирования по частям ТЗ — попадает в analysisNote,
  // чтобы инженер видел, ЧТО именно из ведомости показывалось модели.
  const perSegment = [];

  function buildPassesForSegment(segment, partIdx, partTotal) {
    const tzText = renderSegment(segment);
    const base = { checklist: cl, crossText, partIdx, partTotal };
    if (!entries.length) {
      return [{ label: null, user: buildSegmentUserMessage({ ...base, tzText, vorText: '' }) }];
    }

    // 1) Весь каталог влезает в один проход — показываем целиком.
    let selected = entries;
    let filtered = false;
    if (stats.tokens > VOR_BATCH_TOKENS) {
      // 2) Не влезает — отбираем позиции, релевантные ИМЕННО этой части ТЗ.
      const cand = selectCandidates(index, tzText);
      selected = cand.vor.map((v) => v.entry);
      filtered = true;
    }

    // 3) Даже отобранное не влезает — режем на пакеты (несколько проходов).
    let batches = packCatalog(selected, { budgetTokens: VOR_BATCH_TOKENS });
    let trimmed = 0;
    if (batches.length > VOR_MAX_BATCHES) {
      trimmed = batches.slice(VOR_MAX_BATCHES).reduce((n, b) => n + b.positions, 0);
      batches = batches.slice(0, VOR_MAX_BATCHES).map((b) => ({ ...b, total: VOR_MAX_BATCHES }));
    }
    perSegment.push({
      part: partIdx,
      shown: selected.length,
      total: entries.length,
      batches: batches.length,
      filtered,
      trimmed,
    });

    if (!batches.length) {
      // Ни одна позиция ВОР не относится к этой части ТЗ — честно говорим это
      // модели вместо пустой таблицы.
      return [{
        label: 'вор-нет-кандидатов',
        user: buildSegmentUserMessage({
          ...base,
          tzText,
          vorText:
            `(в ВОР ${entries.length} позиций, ни одна не пересекается по терминам с этой частью ТЗ — ` +
            'работы этой части, скорее всего, в ведомости не учтены; проверь по смыслу)',
        }),
      }];
    }

    return batches.map((batch) => ({
      label: batches.length > 1 ? `вор ${batch.index + 1}/${batches.length}` : null,
      user: buildSegmentUserMessage({
        ...base,
        tzText,
        vorText: renderBatch(batch, {
          totalPositions: stats.positions,
          totalEntries: entries.length,
          shown: selected.length,
          filtered,
          sourceNote,
        }),
      }),
    }));
  }

  const issues = await runLlmStage(context, {
    sourceDocumentId: context.sourceDocumentId,
    systemMsg,
    schema: RESPONSE_SCHEMA,
    schemaName: 'stage1_findings',
    tzBudget,
    concurrency: CONCURRENCY,
    riskCategory: 'покрытие_расчёта',
    issueDefaults: { suggestedAction: 'clarify', confidence: 0.7 },
    analysisNote: notes.length ? notes.join(' ') : null,
    logTag: 'stage1_llm',
    buildUserMessage: buildPassesForSegment,
    combinePasses: intersectPasses,
  });

  // Сводка по ВОР — в отчёт прогона стадии (видно инженеру рядом с находками).
  const maxBatches = perSegment.reduce((m, s) => Math.max(m, s.batches), 0);
  const trimmedParts = perSegment.filter((s) => s.trimmed > 0);
  issues.vor = {
    source,
    positions: stats.positions,
    entries: stats.entries,
    tokens: stats.tokens,
    batch_tokens: VOR_BATCH_TOKENS,
    max_batches_per_part: maxBatches,
    filtered_parts: perSegment.filter((s) => s.filtered).length,
    parts: perSegment.length,
    cross_reference: cross
      ? {
        matched: cross.matched,
        checklist_total: cross.checklist_total,
        in_calc_without_vor: cross.in_calc_without_vor.length,
        vor_without_checklist: cross.vor_without_checklist,
      }
      : null,
  };
  if (maxBatches > 1) {
    notes.push(
      `ВОР (${stats.positions} позиций) показан модели пакетами: до ${maxBatches} пакетов ` +
        `на часть ТЗ; «нет в ВОР» засчитано только по пересечению всех пакетов.`,
    );
  }
  if (trimmedParts.length) {
    notes.push(
      `В ${trimmedParts.length} част(и/ях) ТЗ показаны не все релевантные позиции ВОР ` +
        `(предел ${VOR_MAX_BATCHES} пакетов; STAGE1_VOR_MAX_BATCHES повышает предел).`,
    );
  }
  if (notes.length) issues.analysisNote = notes.join(' ');
  return issues;
}

// buildIssue/locateInBlocks реэкспортируем из shared для офлайн-тестов.
module.exports = {
  runStage1Llm,
  buildIssue,
  locateInBlocks,
  intersectPasses,
  prepareVorCatalog,
  formatChecklist,
  formatCrossReference,
};
