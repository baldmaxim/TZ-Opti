'use strict';

// Стадия 2 — LLM-агент: сверка ТЗ с ПРИНЯТЫМ компанией.
// Два справочника: (A) решения Q&A (СУ-10) и (B) таблица характеристик
// (значения, принятые в расчёт). Агент фиксирует принятое и ищет в ТЗ
// НЕСООТВЕТСТВИЯ обязанностей/значений принятому + сопутствующее. Каждое
// замечание ссылается на конкретный источник (запись Q&A или строку таблицы).
// Большое ТЗ идёт ЧАСТЯМИ (иерархическая сегментация): ОБА справочника
// повторяются в каждой части, поэтому «весь документ в одном контексте» больше
// не требуется, а связи между разделами закрывает финальная межраздельная
// сверка (shared/crossSegmentReview.js). Промт — в stage2Prompts.js.
// Контракт: (context{ blocks, qaEntries, characteristics, sourceDocumentId }) → Issue[]

const { getModel } = require('./llm/openaiClient');
const { buildSystemPrompt, resolveVariant } = require('./stage2Prompts');
const { renderSegment, runLlmStage, buildIssue, locateInBlocks } = require('./shared/llmStage');
const { attachMateriality } = require('./shared/materialityFields');
const { ALL_ACTIONS } = require('../analysis/actions');

const PROBLEM_TYPES = [
  'qa_противоречит_тз',
  'qa_исключено_из_кп',
  'qa_отсутствует_информация',
  'qa_отложенный_ответ',
  'qa_подтверждено',
  'qa_влияет_на_контур',
  'char_противоречит_тз',
  'char_не_отражена',
];

const RESPONSE_SCHEMA = attachMateriality({
  type: 'object',
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'source_kind',
          'source_index',
          'problem_type',
          'fragment',
          'section_path',
          'suggested_action',
          'basis',
          'confidence',
        ],
        properties: {
          source_kind: {
            type: 'string',
            enum: ['qa', 'characteristic'],
            description: 'Откуда взят источник замечания: запись Q&A или строка таблицы характеристик.',
          },
          source_index: {
            type: 'integer',
            description: '1-based номер записи в соответствующем справочнике (список Q&A или таблица характеристик).',
          },
          problem_type: { type: 'string', enum: PROBLEM_TYPES },
          fragment: {
            type: 'string',
            description:
              'ДОСЛОВНАЯ цитата из ТЗ — пункт/обязанность/значение, которого касается замечание. Пустая строка, если привязки к конкретному пункту нет (нет данных / отложено / характеристика не отражена).',
          },
          section_path: { type: 'string', description: 'Путь заголовков ТЗ для цитаты. Иначе пустая строка.' },
          criticality: { type: 'string', enum: ['high', 'medium', 'low'] },
          suggested_action: {
            type: 'string',
            enum: ALL_ACTIONS,
          },
          suggested_redaction: {
            type: 'string',
            description: 'Для replace — предлагаемый текст пункта по принятому решению/значению. Иначе можно пусто.',
          },
          review_comment: { type: 'string', description: 'Краткий комментарий инженеру (на русском). Может быть пустым.' },
          basis: { type: 'string', description: 'В чём несоответствие / что фиксируем.' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
  },
  required: ['findings'],
});

const CHAR_BUDGET = Number(process.env.STAGE_LLM_CHAR_BUDGET) || 400000;
const SCAFFOLD_OVERHEAD = 600;
const QA_Q_MAX = 400;
const QA_A_MAX = 400;
const QA_D_MAX = 500;

function trunc(s, n) {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function flagsLine(e) {
  const flags = [];
  if (e.tz_contradicts) flags.push('tz_contradicts=1');
  if (e.tz_reflected) flags.push('tz_reflected=1');
  if (e.affects_calc) flags.push('affects_calc=1');
  if (e.affects_kp) flags.push('affects_kp=1');
  if (e.affects_contract) flags.push('affects_contract=1');
  if (e.affects_schedule) flags.push('affects_schedule=1');
  return flags.join(', ');
}

function formatQa(entries) {
  const lines = [];
  entries.forEach((e, i) => {
    lines.push(`### Q&A ${i + 1}. Раздел: ${e.section || '—'}${e.round_label ? ` (${e.round_label})` : ''}`);
    if (e.tz_clause) lines.push(`Пункт ТЗ (ссылка инженера): ${e.tz_clause}`);
    lines.push(`Вопрос: ${trunc(e.question, QA_Q_MAX)}`);
    lines.push(`Ответ заказчика: ${trunc(e.answer, QA_A_MAX)}`);
    lines.push(`Принятое решение (СУ-10): ${trunc(e.accepted_decision, QA_D_MAX)}`);
    const fl = flagsLine(e);
    if (fl) lines.push(`Флаги инженера: ${fl}`);
    lines.push('');
  });
  return lines.join('\n').trim();
}

function formatCharacteristics(chars) {
  const lines = [];
  chars.forEach((c, i) => {
    const name = (c.name || '').trim();
    const value = (c.value || '').trim();
    const comment = (c.comment || '').trim();
    lines.push(`### Характеристика ${i + 1}. ${name} = ${value}${comment ? ` (${comment})` : ''}`);
  });
  return lines.join('\n').trim();
}

function buildUserMessage({ tzText, qaText, charsText, partIdx, partTotal }) {
  const partNote =
    partTotal > 1
      ? `## ТЗ — часть ${partIdx}/${partTotal} (markdown)\n\nЭто ФРАГМЕНТ ТЗ. Сверяй справочники с приведённым ниже текстом; ` +
        'остальные части ТЗ сверяются отдельно. Если источник (запись Q&A / характеристика) ' +
        'к этой части не относится — просто не возвращай по нему находку здесь.'
      : '## ТЗ (markdown, целиком)';
  return [
    partNote,
    '',
    tzText && tzText.trim() ? tzText : '(пусто)',
    '',
    '---',
    '## Справочник A — переписка Q&A и принятые решения СУ-10',
    '',
    qaText || '(нет записей Q&A)',
    '',
    '---',
    '## Справочник B — таблица характеристик (принятые в расчёт значения)',
    '',
    charsText || '(нет заполненных характеристик)',
    '',
    '---',
    'Сверь ТЗ с обоими справочниками. Для каждого несоответствия/фиксации верни',
    'находку с source_kind+source_index (привязка к источнику обязательна). Верни',
    'в JSON по схеме (поле findings).',
  ].join('\n');
}

const RISK_CATEGORY_BY_TYPE = {
  qa_противоречит_тз: 'договорной',
  qa_исключено_из_кп: 'объём_работ',
  qa_отсутствует_информация: 'данные',
  qa_отложенный_ответ: 'данные',
  qa_подтверждено: 'фиксация',
  qa_влияет_на_контур: 'фиксация',
};

// Понижение criticality на одну ступень (для tz_reflected).
function downgrade(c) {
  if (c === 'high') return 'medium';
  if (c === 'medium') return 'low';
  return c;
}

function mapQaFinding(f, entry, idx) {
  let problemType = PROBLEM_TYPES.includes(f.problem_type) && f.problem_type.startsWith('qa_')
    ? f.problem_type
    : 'qa_влияет_на_контур';
  let action = f.suggested_action || 'comment';
  let criticality = f.criticality || 'medium';

  // Жёсткий приоритет ручной пометки противоречия.
  if (entry.tz_contradicts) {
    problemType = 'qa_противоречит_тз';
    action = 'replace';
    criticality = 'high';
  } else if (entry.tz_reflected) {
    criticality = downgrade(criticality);
  }

  const qNum = (entry.order_idx ?? idx - 1) + 1;
  const srcTag = `Источник: Q&A №${qNum}, раздел «${entry.section || '—'}»${entry.round_label ? `, ${entry.round_label}` : ''}.`;
  const fragment = (f.fragment || '').trim() || (entry.tz_clause || '') || (entry.section || '') || trunc(entry.question, 80);

  return {
    fragment,
    section_path: f.section_path || '',
    problem_type: problemType,
    risk_category: RISK_CATEGORY_BY_TYPE[problemType] || 'qa',
    criticality,
    suggested_action: action,
    suggested_redaction: f.suggested_redaction || null,
    review_comment: f.review_comment ? `${f.review_comment} ${srcTag}` : srcTag,
    basis: f.basis || `Решение Q&A влияет на ТЗ (${problemType}).`,
    confidence: typeof f.confidence === 'number' ? f.confidence : 0.6,
  };
}

function mapCharFinding(f, ch) {
  const name = (ch.name || '').trim();
  const value = (ch.value || '').trim();
  const srcTag = `Источник: таблица характеристик — «${name}: ${value}».`;

  // Тип по схеме; если модель ошиблась — выводим по наличию цитаты ТЗ.
  let problemType = f.problem_type === 'char_не_отражена' || f.problem_type === 'char_противоречит_тз'
    ? f.problem_type
    : ((f.fragment || '').trim() ? 'char_противоречит_тз' : 'char_не_отражена');

  if (problemType === 'char_противоречит_тз') {
    return {
      fragment: (f.fragment || '').trim() || name,
      section_path: f.section_path || '',
      problem_type: 'char_противоречит_тз',
      risk_category: 'характеристики',
      criticality: f.criticality || 'high',
      suggested_action: f.suggested_action || 'replace',
      suggested_redaction: f.suggested_redaction || `${name}: ${value}`,
      review_comment: f.review_comment
        ? `${f.review_comment} ${srcTag}`
        : `Привести пункт ТЗ в соответствие с принятой характеристикой. ${srcTag}`,
      basis: f.basis || `ТЗ расходится с принятой характеристикой «${name}: ${value}».`,
      confidence: typeof f.confidence === 'number' ? f.confidence : 0.7,
    };
  }

  // char_не_отражена — безъякорно (fragment=имя характеристики, в ТЗ обычно не
  // находится → keepUnlocated сохраняет находку).
  return {
    fragment: name,
    section_path: f.section_path || '',
    problem_type: 'char_не_отражена',
    risk_category: 'характеристики',
    criticality: f.criticality || 'medium',
    suggested_action: f.suggested_action || 'comment',
    suggested_redaction: f.suggested_redaction || `Зафиксировать в ТЗ / допущениях КП: «${name}: ${value}».`,
    review_comment: f.review_comment
      ? `${f.review_comment} ${srcTag}`
      : `Принятая характеристика не отражена в ТЗ. ${srcTag}`,
    basis: f.basis || `Принятая характеристика «${name}: ${value}» не отражена в тексте ТЗ.`,
    confidence: typeof f.confidence === 'number' ? f.confidence : 0.55,
  };
}

// Нормализатор находки Стадии 2 → стандартная находка. Закрывает оба справочника
// для резолва source_kind+source_index и применения ручных флагов инженера.
function makeMapFinding(entries, chars) {
  return function mapFinding(f) {
    const idx = Number(f.source_index);
    if (f.source_kind === 'characteristic') {
      const ch = Number.isInteger(idx) && idx >= 1 && idx <= chars.length ? chars[idx - 1] : null;
      if (!ch) return null;
      return mapCharFinding(f, ch);
    }
    // По умолчанию трактуем как Q&A.
    const entry = Number.isInteger(idx) && idx >= 1 && idx <= entries.length ? entries[idx - 1] : null;
    if (!entry) return null;
    return mapQaFinding(f, entry, idx);
  };
}

async function runStage2Llm(context) {
  const { blocks, qaEntries, characteristics } = context;
  if (!Array.isArray(blocks) || !blocks.length) {
    const err = new Error('ТЗ.md пуст или не парсится. Загрузите корректный .md в слот ТЗ.');
    err.status = 400;
    throw err;
  }
  const entries = Array.isArray(qaEntries) ? qaEntries : [];
  // Сверяем только характеристики с непустым значением (пустые — нечего сверять).
  const chars = (Array.isArray(characteristics) ? characteristics : []).filter(
    (c) => (c.value || '').trim(),
  );

  const promptVariant = resolveVariant();
  const systemMsg = buildSystemPrompt(promptVariant);
  // eslint-disable-next-line no-console
  console.log(
    `[stage2_llm] model=${getModel()} promptVariant=${promptVariant} blocks=${blocks.length} Q&A=${entries.length} характеристик(с value)=${chars.length}`,
  );
  if (!entries.length && !chars.length) return [];

  const qaText = formatQa(entries);
  const charsText = formatCharacteristics(chars);
  const tzBudget = CHAR_BUDGET - qaText.length - charsText.length - SCAFFOLD_OVERHEAD - systemMsg.length;
  if (tzBudget <= 0) {
    const err = new Error('Справочники Q&A + характеристики превышают бюджет контекста. Сократите вход.');
    err.status = 400;
    throw err;
  }

  return runLlmStage(context, {
    sourceDocumentId: context.sourceDocumentId,
    systemMsg,
    schema: RESPONSE_SCHEMA,
    schemaName: 'stage2_findings',
    tzBudget,
    concurrency: 1,
    issueDefaults: { suggestedAction: 'comment', confidence: 0.6 },
    logTag: 'stage2_llm',
    keepUnlocated: true,
    mapFinding: makeMapFinding(entries, chars),
    buildUserMessage: (segment, partIdx, partTotal) =>
      buildUserMessage({ tzText: renderSegment(segment), qaText, charsText, partIdx, partTotal }),
  });
}

// makeMapFinding реэкспортируем для офлайн-тестов (как buildIssue/locateInBlocks).
module.exports = { runStage2Llm, makeMapFinding, buildIssue, locateInBlocks };
