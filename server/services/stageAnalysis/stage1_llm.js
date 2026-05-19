'use strict';

// Стадия 1 — LLM-агент (OpenAI GPT-4o).
// Заменяет rule-based runStage1 (сохранён в stage1_checklistVor.js как fallback/история).
//
// Контракт: (context) → Issue[]
// context = {
//   tenderId, sourceDocumentId,
//   blocks,        // плоский массив блоков из parseMdToBlocks (с section_path);
//                  // ТЗ для модели рендерим из блоков посегментно (rawMd не шлём)
//   vorText,       // текст ВОР (plain или CSV)
//   checklist,     // строки work_checklist_items: { work_name, in_calc, ... }
// }
//
// Поток:
// 1. Разбить блоки ТЗ на сегменты под бюджет контекста (крупные ТЗ не влезают
//    в стандартное окно Claude целиком — см. project_stage1_context_limit).
// 2. Для КАЖДОГО сегмента: system + user (сегмент ТЗ + полный ВОР + чек-лист),
//    вызов chat.completions со structured output (JSON schema).
// 3. Слить findings[] всех сегментов → дедуп.
// 4. Для каждого finding — найти точную позицию во ВСЕХ блоках через locateInBlocks.
// 5. Дропнуть finding'и, чьи фрагменты не находятся в исходном тексте (не выдумываем позицию).
// 6. Построить Issue[] для записи в БД.

const { findInParagraphs } = require('./shared/fragmentMatcher');
const { chatJson, getModel } = require('./llm/openaiClient');
const { buildSystemPrompt, resolveVariant } = require('./stage1Prompts');

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'fragment',
          'section_path',
          'problem_type',
          'criticality',
          'suggested_action',
          'basis',
          'confidence',
        ],
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
            enum: ['comment', 'replace', 'delete', 'remove_from_scope', 'clarify', 'limit_scope', 'assumption'],
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

// ── Компактизация ВОР (только наименования) ──────────────────────────────────
// xlsx-экстракт ВОР («Форма КП СМР») — многостраничная таблица на ~30 колонок,
// сотни строк, ~440K симв. Для Стадии 1 нужно одно: СПИСОК НАИМЕНОВАНИЙ работ
// (учтена работа в КП или нет) — не цены, объёмы, ед.изм., примечания, повторы
// по корпусам. Поэтому из каждой строки берём ТОЛЬКО самую длинную осмысленную
// ячейку (это и есть наименование работы), плюс:
//   • пустые ячейки/строки, кавычки, схлопывание пробелов;
//   • ячейки без букв (цены, объёмы, %, даты, номера колонок);
//   • служебные блоки «Фиксированная/Переменная часть (… руб …)»;
//   • ссылки на ПД («ПД-00232130-…», «лист(ы) …»);
//   • строки, где осталась лишь ед.изм. / слишком короткий огрызок;
//   • ГЛОБАЛЬНЫЙ дедуп (КП повторяет одну работу по корпусам 36/39/40).
// Заточено под формат «Форма КП СМР». Сырой extracted_text в БД не трогаем —
// компактим только для LLM. См. project_stage1_context_limit.
const VOR_MIN_NAME_LEN = 5; // короче — это не наименование работы
const VOR_UNIT_TOKENS = new Set([
  'м2', 'м3', 'м', 'м.п', 'м.п.', 'пог.м', 'мп', 'шт', 'шт.', 'к-с', 'к/с',
  'компл', 'компл.', 'т', 'кг', 'чел', '%', 'маш-ч', 'маш.-ч', 'м.куб',
  'м.кв', 'ед', 'ед.', 'усл', 'усл.',
]);
const VOR_HAS_LETTER = /[A-Za-zА-Яа-яЁё]/;
const VOR_BOILERPLATE = /(Фиксированная|Переменная)\s+часть\s*(\([^)]*\))?/gi;
const VOR_PD_REF = /^(ПД[\s-]?\d|лист[ыа]?\b|листы\b)/i;

function cleanVorCell(raw) {
  let c = raw.trim().replace(/^"+|"+$/g, '').replace(/\s+/g, ' ').trim();
  c = c.replace(VOR_BOILERPLATE, '').replace(/\s+/g, ' ').trim();
  if (!c) return '';
  if (VOR_PD_REF.test(c)) return '';
  if (!VOR_HAS_LETTER.test(c)) return ''; // цены, объёмы, %, даты, № колонок
  return c;
}

function compactVor(text) {
  if (!text) return '';
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('#')) {
      out.push(t.replace(/\s+/g, ' '));
      continue;
    }
    const cells = (t.includes('|') ? t.split('|') : [t])
      .map(cleanVorCell)
      .filter((c) => c.length);
    if (!cells.length) continue;
    // Берём только самую длинную ячейку строки — это наименование работы
    // (ед.изм. короткие, примечания короче полного описания работы).
    const name = cells.reduce((a, b) => (b.length > a.length ? b : a), '');
    if (name.length < VOR_MIN_NAME_LEN) continue;
    if (VOR_UNIT_TOKENS.has(name.toLowerCase())) continue;
    out.push(name);
  }
  // Глобальный дедуп с сохранением порядка первого вхождения.
  const seen = new Set();
  const dedup = [];
  for (const l of out) {
    if (seen.has(l)) continue;
    seen.add(l);
    dedup.push(l);
  }
  return dedup.join('\n');
}

// ── Сегментация ТЗ под бюджет контекста ──────────────────────────────────────
// Крупные ТЗ (~574K симв ≈ ~230K токенов) переполняют стандартное окно Claude
// (см. project_stage1_context_limit). Режем блоки ТЗ на части так, чтобы
// каждый запрос (сегмент + полный ВОР + чек-лист + каркас) влезал в бюджет.
// ВОР и чек-лист идут с КАЖДЫМ сегментом — без них модель не оценит покрытие.
// ПРОВЕРЕНО ЭМПИРИЧЕСКИ (тендер 311): подписка Claude Code НЕ держит
// параллель — конкурентные вызовы троттлятся, голодают и ловят таймаут;
// мелкие сегменты последовательно тоже медленнее (больше вызовов, фикс.
// оверхед на каждый). Поэтому дефолт — один большой сегмент + sequential
// (CONCURRENCY=1) = единственный надёжный/самый быстрый путь (~6-7 мин).
// Параллель оставлена за env на случай платного API в будущем.
const CHAR_BUDGET = Number(process.env.STAGE1_CHAR_BUDGET) || 400000;
const CONCURRENCY = Math.max(1, Number(process.env.STAGE1_CONCURRENCY) || 1);
const PER_BLOCK_OVERHEAD = 8; // заголовок-разметка + переводы строк
const SCAFFOLD_OVERHEAD = 600; // фиксированный текст шаблона user-сообщения
// Порог скорости: ВОР даже после «только наименований» бывает крупным
// (Символ: 440K→112K). Большой ВОР в каждом вызове = анализ не успевает за
// таймаут. Если компакт-ВОР > порога — авто-уход в запасной режим (только
// чек-лист, быстро и надёжно, с пометкой ⚠). Настраивается env.
const VOR_MAX_CHARS = Number(process.env.STAGE1_VOR_MAX_CHARS) || 90000;

// Рендер сегмента: заголовки как markdown (#), прочее — дословный block.text
// (fragment в ответе модели должен дословно совпасть с block.text — это нужно
// locateInBlocks). Дословность не нарушаем.
function renderSegment(segBlocks) {
  const parts = [];
  for (const b of segBlocks) {
    if (b.type === 'heading') {
      parts.push(`${'#'.repeat(Math.max(1, b.level || 1))} ${b.text}`);
    } else {
      parts.push(b.text);
    }
  }
  return parts.join('\n');
}

// Стандартные НЕ-рабочие разделы ТЗ — прямо в анти-критериях промта (никогда
// не флагаются). Не шлём их в LLM: 0 влияния на находки, меньше токенов.
// Узкие паттерны заголовков, чтобы случайно не срезать раздел с работами.
const VOR_BOILERPLATE_HEADING =
  /^\s*(?:\d+[.\d\s]*)?(термины и определения|определения и сокращения|термины,?\s*определения и сокращения|(?:список|перечень|обозначения и)\s+сокращени\w*|нормативн\w+\s+(?:ссылк\w+|документ\w+)|перечень нормативн\w+|реквизиты сторон|(?:юридические )?адреса и реквизиты|содержание|оглавление)\s*$/i;

function isBoilerplateBlock(b) {
  if (b && b.type === 'heading' && VOR_BOILERPLATE_HEADING.test(b.text || '')) {
    return true;
  }
  const sp = (b && b.section_path) || [];
  return sp.some((h) => VOR_BOILERPLATE_HEADING.test(h || ''));
}

// Жадная упаковка блоков в сегменты под tzBudget. Блок крупнее бюджета
// уходит в собственный (одиночный) сегмент — дробить его нельзя без потери
// дословности; крайний случай отловит fail-loud бриджа с понятной ошибкой.
function segmentBlocks(blocks, tzBudget) {
  const segments = [];
  let cur = [];
  let curLen = 0;
  for (const b of blocks) {
    const blockLen = (b.text || '').length + PER_BLOCK_OVERHEAD;
    if (cur.length && curLen + blockLen > tzBudget) {
      segments.push(cur);
      cur = [];
      curLen = 0;
    }
    cur.push(b);
    curLen += blockLen;
  }
  if (cur.length) segments.push(cur);
  return segments;
}

function buildSegmentUserMessage({ tzText, vorText, checklist, partIdx, partTotal }) {
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
    '## ВОР',
    '',
    vor,
    '',
    '---',
    '## Чек-лист работ компании',
    '',
    formatChecklist(checklist),
    '',
    '---',
    'Найди в приведённой части ТЗ фрагменты, описывающие работы, не учтённые в ВОР и в чек-листе как in_calc=1.',
    'Верни их списком в JSON по схеме (поле findings).',
  ].join('\n');
}

// Грубая нормализация для substring-локализации фрагмента в блоках.
// Совпадение должно быть точным после нормализации пробелов.
function normalizeForLocate(s) {
  return (s || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function locateInBlocks(blocks, fragment) {
  const ndl = normalizeForLocate(fragment);
  if (!ndl) return null;

  // 1) Сначала точное вхождение в нормализованной форме.
  for (const block of blocks) {
    const haystackNorm = normalizeForLocate(block.text);
    const idxNorm = haystackNorm.indexOf(ndl);
    if (idxNorm === -1) continue;

    // Перевести позицию из нормализованного представления в исходное:
    // findInParagraphs делает substring-поиск с учётом нижнего регистра и ё→е,
    // что близко по семантике; используем его для позиции внутри ОДНОГО блока.
    const hits = findInParagraphs([block], fragment);
    if (hits.length) {
      const hit = hits[0];
      return { block, char_start: hit.char_start, char_end: hit.char_end, fragment: hit.fragment };
    }
    // Если findInParagraphs не нашёл (различие нормализаций), берём приближение.
    return {
      block,
      char_start: 0,
      char_end: Math.min(block.text.length, fragment.length),
      fragment: block.text.slice(0, Math.min(block.text.length, fragment.length)),
    };
  }

  return null;
}

function buildIssue({ sourceDocumentId, finding, located }) {
  const sectionPath = (finding.section_path || '').trim() || (located?.block?.section_path?.join(' › ') || null);
  return {
    source_document_id: sourceDocumentId || null,
    source_clause: located?.block ? `п. ${located.block.index + 1}` : null,
    source_fragment: located?.fragment || finding.fragment,
    paragraph_index: located?.block?.index ?? null,
    char_start: located?.char_start ?? null,
    char_end: located?.char_end ?? null,
    problem_type: finding.problem_type || null,
    risk_category: 'покрытие_расчёта',
    criticality: finding.criticality || 'medium',
    price_impact: finding.criticality === 'high' ? 'высокое' : 'возможно',
    schedule_impact: 'возможно',
    basis: finding.basis || null,
    suggested_action: finding.suggested_action || 'clarify',
    suggested_redaction: finding.suggested_redaction || null,
    review_comment: finding.review_comment || null,
    confidence: typeof finding.confidence === 'number' ? finding.confidence : 0.7,
    section_path: sectionPath || null,
  };
}

function dedupe(findings) {
  const seen = new Set();
  const out = [];
  for (const f of findings) {
    const key = `${(f.fragment || '').trim()}|${(f.section_path || '').trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

async function runStage1Llm(context) {
  const { sourceDocumentId, blocks, vorText, checklist } = context;

  if (!Array.isArray(blocks) || !blocks.length) {
    const err = new Error('ТЗ.md пуст или не парсится. Загрузите корректный .md в слот ТЗ.');
    err.status = 400;
    throw err;
  }

  const promptVariant = resolveVariant();
  const systemMsg = buildSystemPrompt(promptVariant);
  const vorRaw = vorText || '';
  const vor = compactVor(vorRaw);
  const cl = checklist || [];
  const clText = formatChecklist(cl);
  // eslint-disable-next-line no-console
  console.log(`[stage1_llm] ВОР: ${vorRaw.length}ch → компакт ${vor.length}ch`);

  // ВОР + чек-лист + каркас идут с каждым сегментом — вычитаем их из бюджета.
  // Если ВОР даже после глубокой чистки не оставляет места под ТЗ — запасной
  // режим: ВОР пропускаем, сверяем ТЗ только с чек-листом (решение владельца).
  const VOR_SKIPPED_MARKER =
    '(ВОР пропущен — слишком большой для бесплатного контекста; сверяй только с чек-листом)';
  const overheadWith = (v) =>
    v.length + clText.length + SCAFFOLD_OVERHEAD + systemMsg.length;

  let vorForLlm = vor;
  let analysisNote = null;
  // Запасной режим, если: (а) ВОР слишком большой даже после чистки (анализ
  // не успеет за таймаут) ИЛИ (б) ВОР не оставляет места под ТЗ в бюджете.
  const vorTooBig = vor.length > VOR_MAX_CHARS;
  let tzBudget = CHAR_BUDGET - overheadWith(vorForLlm);
  if (vorTooBig || tzBudget <= 0) {
    vorForLlm = VOR_SKIPPED_MARKER;
    analysisNote = vorTooBig
      ? `ВОР пропущен: после чистки до наименований ${vor.length} симв — это ` +
        `слишком много, анализ с ВОР не успевает. Стадия 1 свела ТЗ только с ` +
        `чек-листом компании; кросс-сверка с ВОР не выполнялась.`
      : `ВОР пропущен: после глубокой чистки ${vor.length} симв — не влезает в ` +
        `бесплатный контекст вместе с ТЗ. Стадия 1 свела ТЗ только с чек-листом ` +
        `компании; кросс-сверка с ВОР не выполнялась.`;
    tzBudget = CHAR_BUDGET - overheadWith(vorForLlm);
    // eslint-disable-next-line no-console
    console.warn(`[stage1_llm] ЗАПАСНОЙ РЕЖИМ: ${analysisNote}`);
  }
  if (tzBudget <= 0) {
    const err = new Error(
      'Чек-лист сам по себе превышает бюджет контекста — даже без ВОР ТЗ не влезает. ' +
        'Нужно сократить чек-лист (отдельная задача).',
    );
    err.status = 400;
    throw err;
  }

  // Анализируем без стандартных НЕ-рабочих разделов (меньше токенов, 0
  // влияния на находки). Локализация фрагментов идёт по ПОЛНЫМ blocks ниже —
  // их не трогаем.
  const analyzedBlocks = blocks.filter((b) => !isBoilerplateBlock(b));
  const droppedBoiler = blocks.length - analyzedBlocks.length;
  const segments = segmentBlocks(
    analyzedBlocks.length ? analyzedBlocks : blocks,
    tzBudget,
  );
  // eslint-disable-next-line no-console
  console.log(
    `[stage1_llm] model=${getModel()} promptVariant=${promptVariant} blocks=${blocks.length} (boilerplate-=${droppedBoiler}) segments=${segments.length} concurrency=${CONCURRENCY} tzBudget=${tzBudget}ch vorSkipped=${!!analysisNote}`,
  );

  const startedAt = Date.now();
  // Параллельный запуск волнами по CONCURRENCY (супер-линейная кривая: мелкие
  // вызовы параллельно сильно быстрее одного большого). Та же модель/промт/
  // охват → качество не меняется. fail-loud сохранён (номер части в ошибке).
  const results = new Array(segments.length);
  for (let start = 0; start < segments.length; start += CONCURRENCY) {
    const wave = [];
    for (let i = start; i < Math.min(start + CONCURRENCY, segments.length); i += 1) {
      const idx = i;
      const tzText = renderSegment(segments[idx]);
      const userMsg = buildSegmentUserMessage({
        tzText,
        vorText: vorForLlm,
        checklist: cl,
        partIdx: idx + 1,
        partTotal: segments.length,
      });
      wave.push(
        chatJson({
          system: systemMsg,
          user: userMsg,
          jsonSchema: RESPONSE_SCHEMA,
          schemaName: 'stage1_findings',
        })
          .then((json) => {
            const segFindings = Array.isArray(json?.findings) ? json.findings : [];
            // eslint-disable-next-line no-console
            console.log(
              `[stage1_llm] часть ${idx + 1}/${segments.length}: tz=${tzText.length}ch findings=${segFindings.length}`,
            );
            results[idx] = segFindings;
          })
          .catch((e) => {
            // fail-loud с указанием части (решение владельца)
            const err = new Error(
              `Стадия 1: часть ${idx + 1}/${segments.length} — ${e.message}`,
            );
            err.status = e.status || 502;
            err.cause = e;
            throw err;
          }),
      );
    }
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(wave);
  }
  const allFindings = [];
  for (const r of results) if (r) allFindings.push(...r);
  const elapsedMs = Date.now() - startedAt;
  // eslint-disable-next-line no-console
  console.log(
    `[stage1_llm] все ${segments.length} частей за ${elapsedMs}ms, findings(сырых)=${allFindings.length}`,
  );

  const findings = dedupe(allFindings);

  const issues = [];
  let dropped = 0;
  for (const f of findings) {
    const located = locateInBlocks(blocks, f.fragment);
    if (!located) {
      dropped += 1;
      // eslint-disable-next-line no-console
      console.warn(`[stage1_llm] dropped finding (fragment not located in TZ): ${JSON.stringify(f.fragment).slice(0, 120)}`);
      continue;
    }
    issues.push(buildIssue({ sourceDocumentId, finding: f, located }));
  }
  if (dropped) {
    // eslint-disable-next-line no-console
    console.log(`[stage1_llm] dropped ${dropped} findings out of ${findings.length}`);
  }

  // Запасной режим: помечаем результат, чтобы движок положил note в summary,
  // а UI показал пользователю, что ВОР не сверялся.
  if (analysisNote) issues.analysisNote = analysisNote;
  return issues;
}

module.exports = { runStage1Llm };
