'use strict';

// Стадия 3 — LLM-агент: ТЗ vs существенные условия компании.
// Справочник = отрендеренные стандартные условия (с учётом параметров тендера
// и per-tender override). Модель судит КАЖДОЕ условие против ВСЕГО ТЗ:
//   не_отображено        → условие не упомянуто в ТЗ (безъякорный Issue)
//   противоречит         → ТЗ говорит несовместимое (Issue с цитатой ТЗ)
//   отражено_корректно   → пропускаем
// Поэтому нужен ВЕСЬ ТЗ в одном контексте (requireSingleSegment): посегментно
// «не отражено» посчиталось бы неверно. Контракт: (context) → Issue[]

const db = require('../../db/connection');
const { getModel } = require('./llm/openaiClient');
const {
  defaultsFor,
  renderConditions,
  tenderTypeToContractKind,
} = require('../conditionsRenderer');
const { renderSegment, runLlmStage, buildIssue, locateInBlocks } = require('./shared/llmStage');

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['condition_name', 'status', 'fragment', 'section_path', 'basis', 'confidence'],
        properties: {
          condition_name: {
            type: 'string',
            description: 'Наименование условия из справочника (скопируй дословно).',
          },
          status: {
            type: 'string',
            enum: ['не_отражено', 'противоречит', 'отражено_корректно'],
          },
          fragment: {
            type: 'string',
            description:
              'Если status=противоречит — ДОСЛОВНАЯ цитата из ТЗ, которая противоречит условию. Иначе пустая строка.',
          },
          section_path: {
            type: 'string',
            description: 'Путь заголовков ТЗ для цитаты (если есть). Иначе пустая строка.',
          },
          criticality: { type: 'string', enum: ['high', 'medium', 'low'] },
          suggested_redaction: {
            type: 'string',
            description: 'Предлагаемая формулировка для ТЗ/КП (как правило — стандартный текст условия). Может быть пустой.',
          },
          review_comment: {
            type: 'string',
            description: 'Краткий комментарий инженеру (на русском). Может быть пустым.',
          },
          basis: { type: 'string', description: 'Почему не отражено / в чём противоречие.' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
  },
  required: ['findings'],
};

const SYSTEM_PROMPT = [
  'Ты — Руководитель строительства / договорной специалист Генподрядчика (ГП).',
  'Заказчик прислал ТЗ на СОГЛАСОВАНИЕ. Тебе дан СПИСОК существенных условий',
  'компании (стандартные договорные позиции ГП: гарантия, аванс, эскалация,',
  'сроки, порядок приёмки и т.п.). Задача: для КАЖДОГО условия определить, как',
  'оно отражено в присланном ТЗ.',
  '',
  'ДЛЯ КАЖДОГО УСЛОВИЯ выставь status:',
  '• не_отражено — в ТЗ нет ничего по теме условия (его нужно внести в КП/',
  '  договор или вынести в допущения). fragment оставь пустым.',
  '• противоречит — ТЗ затрагивает эту тему, но условие в ТЗ НЕСОВМЕСТИМО со',
  '  стандартом компании (например иной гарантийный срок, иной аванс, иной',
  '  порядок). fragment — ДОСЛОВНАЯ цитата из ТЗ с противоречием.',
  '• отражено_корректно — тема есть в ТЗ и не противоречит стандарту компании.',
  '  Такие в ответ можно не включать (или включить со статусом отражено_корректно).',
  '',
  'ПРАВИЛА:',
  '• Анализируй условие против ВСЕГО приведённого текста ТЗ (он дан целиком).',
  '• condition_name — дословно из справочника.',
  '• fragment для противоречия — дословная цитата из ТЗ, иначе привязка не',
  '  сработает.',
  '• suggested_redaction — обычно стандартный текст условия (можно адаптировать).',
  '• Не выдумывай условия вне справочника.',
  '',
  'НЕ дублируй другие стадии: объём/ВОР → Стадия 1; Q&A → Стадия 2; типовые',
  'риски → Стадия 4; самоанализ формулировок → Стадия 5. Здесь — только сверка',
  'ТЗ с существенными условиями компании.',
  '',
  'Рассуждай про себя — верни только итоговый JSON (поле findings).',
].join('\n');

const CHAR_BUDGET = Number(process.env.STAGE_LLM_CHAR_BUDGET) || 400000;
const SCAFFOLD_OVERHEAD = 600;

// Загружает существенные условия тендера (рендер стандартных + per-tender
// override), как делает rule-based runStage3. Возвращает [{ name, text,
// comment, criticality }].
async function loadConditions(tenderId) {
  const tender = await db.queryOne('SELECT * FROM tenders WHERE id = ?', tenderId);
  if (!tender) return [];
  // Колонка тендера — `type` (general_contract | shell | …); rule-based Стадия 3
  // читала несуществующий `contract_type` и всегда сваливалась в 'shell'.
  const kind = tenderTypeToContractKind(tender.type);
  const paramsRow = await db.queryOne('SELECT * FROM tender_setup_params WHERE tender_id = ?', tenderId);
  const params = { ...defaultsFor(kind), ...(paramsRow || {}) };
  const rendered = renderConditions(kind, params); // [{ idx, name, text, ... }]

  const overrides = await db.queryAll(
    `SELECT condition_idx, text_override, comment, criticality
     FROM company_conditions WHERE tender_id = ?`,
    tenderId,
  );
  const ovByIdx = new Map();
  for (const o of overrides) ovByIdx.set(o.condition_idx, o);

  const out = [];
  for (const cond of rendered) {
    const ov = ovByIdx.get(cond.idx);
    const text = (ov?.text_override || cond.text || '').trim();
    const name = (cond.name || '').trim();
    if (!name && !text) continue;
    out.push({
      name,
      text,
      comment: ov?.comment || null,
      criticality: ov?.criticality || null,
    });
  }
  return out;
}

function formatConditions(conds) {
  const lines = [];
  conds.forEach((c, i) => {
    lines.push(`### ${i + 1}. ${c.name}`);
    if (c.text) lines.push(`Стандарт компании: ${c.text}`);
    if (c.comment) lines.push(`Примечание компании: ${c.comment}`);
    lines.push('');
  });
  return lines.join('\n').trim();
}

function buildUserMessage({ tzText, condsText }) {
  return [
    '## ТЗ (markdown, целиком)',
    '',
    tzText && tzText.trim() ? tzText : '(пусто)',
    '',
    '---',
    '## Существенные условия компании (справочник)',
    '',
    condsText,
    '',
    '---',
    'Для каждого условия определи status (не_отражено / противоречит /',
    'отражено_корректно) против всего текста ТЗ. Верни в JSON по схеме (поле findings).',
  ].join('\n');
}

// Нормализатор находки Стадии 3 → стандартная находка для buildIssue.
// Возвращает null для отражено_корректно (фильтруется раннером).
function makeMapFinding(byName) {
  return function mapFinding(f) {
    const status = f.status;
    if (status === 'отражено_корректно' || !status) return null;
    const name = (f.condition_name || '').trim();
    const cond = byName.get(name) || null;

    if (status === 'противоречит') {
      return {
        fragment: f.fragment || name,
        section_path: f.section_path || '',
        problem_type: 'условие_противоречит',
        risk_category: 'существенные_условия',
        criticality: (cond && cond.criticality) || f.criticality || 'high',
        suggested_action: 'replace',
        suggested_redaction: f.suggested_redaction || (cond && cond.text) || null,
        review_comment:
          f.review_comment || `ТЗ противоречит существенному условию компании «${name}». Привести в соответствие.`,
        basis: f.basis || `ТЗ противоречит стандартному условию компании «${name}».`,
        confidence: typeof f.confidence === 'number' ? f.confidence : 0.7,
      };
    }

    // не_отражено — безъякорный Issue (fragment=имя условия, в ТЗ обычно не
    // находится → keepUnlocated сохраняет находку).
    return {
      fragment: name,
      section_path: f.section_path || '',
      problem_type: 'условие_не_отражено',
      risk_category: 'существенные_условия',
      criticality: (cond && cond.criticality) || f.criticality || 'medium',
      suggested_action: 'clarify',
      suggested_redaction: f.suggested_redaction || (cond && cond.text) || null,
      review_comment:
        f.review_comment ||
        'Существенное условие компании не отражено в ТЗ. Добавить в КП/договор или вынести в допущения.',
      basis: f.basis || `Существенное условие компании «${name}» не упоминается в ТЗ.`,
      confidence: typeof f.confidence === 'number' ? f.confidence : 0.55,
    };
  };
}

async function runStage3Llm(context) {
  const { blocks, tenderId } = context;
  if (!Array.isArray(blocks) || !blocks.length) {
    const err = new Error('ТЗ.md пуст или не парсится. Загрузите корректный .md в слот ТЗ.');
    err.status = 400;
    throw err;
  }

  const conds = await loadConditions(tenderId);
  // eslint-disable-next-line no-console
  console.log(`[stage3_llm] model=${getModel()} blocks=${blocks.length} условий: ${conds.length}`);
  if (!conds.length) {
    const issues = [];
    issues.analysisNote = 'Нет существенных условий для этого тендера — Стадия 3 пропущена.';
    return issues;
  }

  const condsText = formatConditions(conds);
  const byName = new Map(conds.map((c) => [c.name, c]));
  const tzBudget = CHAR_BUDGET - condsText.length - SCAFFOLD_OVERHEAD - SYSTEM_PROMPT.length;
  if (tzBudget <= 0) {
    const err = new Error('Справочник условий превышает бюджет контекста.');
    err.status = 400;
    throw err;
  }

  return runLlmStage(context, {
    sourceDocumentId: context.sourceDocumentId,
    systemMsg: SYSTEM_PROMPT,
    schema: RESPONSE_SCHEMA,
    schemaName: 'stage3_findings',
    tzBudget,
    concurrency: 1,
    riskCategory: 'существенные_условия',
    issueDefaults: { suggestedAction: 'clarify', confidence: 0.55 },
    logTag: 'stage3_llm',
    keepUnlocated: true,
    requireSingleSegment: true,
    mapFinding: makeMapFinding(byName),
    buildUserMessage: (segBlocks) =>
      buildUserMessage({ tzText: renderSegment(segBlocks), condsText }),
  });
}

module.exports = { runStage3Llm, buildIssue, locateInBlocks };
