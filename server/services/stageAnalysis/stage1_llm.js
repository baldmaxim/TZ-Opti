'use strict';

// Стадия 1 — LLM-агент: ТЗ vs ВОР/чек-лист (что ГП не выполняет по объёму).
// Generic-каркас (сегментация/locate/весь-пункт/дедуп/раннер) — в
// shared/llmStage.js. Здесь только Stage-1-специфика: компактизация ВОР,
// чек-лист, запасной режим (ВОР пропущен), схема и сборка user-сообщения.
//
// Контракт: (context{ sourceDocumentId, blocks, vorText, checklist }) → Issue[]

const { getModel } = require('./llm/openaiClient');
const { buildSystemPrompt, resolveVariant } = require('./stage1Prompts');
const {
  renderSegment,
  runLlmStage,
  buildIssue,
  locateInBlocks,
} = require('./shared/llmStage');
const { ALL_ACTIONS } = require('../analysis/actions');

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

// ── Компактизация ВОР (только наименования) ──────────────────────────────────
// xlsx-экстракт ВОР («Форма КП СМР») — таблица на ~30 колонок, ~440K симв.
// Для Стадии 1 нужен СПИСОК НАИМЕНОВАНИЙ работ: из строки берём самую длинную
// осмысленную ячейку, режем цены/ед.изм./служебные блоки/ссылки на ПД,
// глобальный дедуп. Сырой extracted_text в БД не трогаем.
const VOR_MIN_NAME_LEN = 5;
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
  if (!VOR_HAS_LETTER.test(c)) return '';
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
    const name = cells.reduce((a, b) => (b.length > a.length ? b : a), '');
    if (name.length < VOR_MIN_NAME_LEN) continue;
    if (VOR_UNIT_TOKENS.has(name.toLowerCase())) continue;
    out.push(name);
  }
  const seen = new Set();
  const dedup = [];
  for (const l of out) {
    if (seen.has(l)) continue;
    seen.add(l);
    dedup.push(l);
  }
  return dedup.join('\n');
}

// Бюджет/конкурентность Стадии 1. Подписка не держит параллель → дефолт
// один большой сегмент, sequential. Параллель за env (на платный API).
const CHAR_BUDGET = Number(process.env.STAGE1_CHAR_BUDGET) || 400000;
const CONCURRENCY = Math.max(1, Number(process.env.STAGE1_CONCURRENCY) || 1);
const SCAFFOLD_OVERHEAD = 600;
// Если компакт-ВОР > порога — запасной режим (ВОР пропущен, только чек-лист).
const VOR_MAX_CHARS = Number(process.env.STAGE1_VOR_MAX_CHARS) || 90000;

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

async function runStage1Llm(context) {
  const { blocks, vorText, checklist } = context;

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
  console.log(
    `[stage1_llm] model=${getModel()} promptVariant=${promptVariant} ВОР: ${vorRaw.length}ch → компакт ${vor.length}ch`,
  );

  const VOR_SKIPPED_MARKER =
    '(ВОР пропущен — слишком большой для бесплатного контекста; сверяй только с чек-листом)';
  const overheadWith = (v) =>
    v.length + clText.length + SCAFFOLD_OVERHEAD + systemMsg.length;

  let vorForLlm = vor;
  let analysisNote = null;
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

  return runLlmStage(context, {
    sourceDocumentId: context.sourceDocumentId,
    systemMsg,
    schema: RESPONSE_SCHEMA,
    schemaName: 'stage1_findings',
    tzBudget,
    concurrency: CONCURRENCY,
    riskCategory: 'покрытие_расчёта',
    issueDefaults: { suggestedAction: 'clarify', confidence: 0.7 },
    analysisNote,
    logTag: 'stage1_llm',
    buildUserMessage: (segBlocks, partIdx, partTotal) =>
      buildSegmentUserMessage({
        tzText: renderSegment(segBlocks),
        vorText: vorForLlm,
        checklist: cl,
        partIdx,
        partTotal,
      }),
  });
}

// buildIssue/locateInBlocks реэкспортируем из shared для офлайн-тестов.
module.exports = { runStage1Llm, buildIssue, locateInBlocks };
