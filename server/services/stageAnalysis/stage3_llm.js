'use strict';

// Стадия 3 — LLM-агент: ТЗ vs существенные условия компании.
// ОСНОВА — условия компании (источник истины): отрендеренные стандартные условия
// с учётом параметров тендера и per-tender override. Агент ищет в ТЗ места,
// которые им ПРОТИВОРЕЧАТ, и выносит на рассмотрение:
//   противоречит         → ТЗ говорит несовместимое (Issue с цитатой ТЗ)
//   отражено_корректно   → пропускаем
// Условия, которых в ТЗ нет вовсе, НЕ флагаются (отсутствие договорного условия
// в техническом ТЗ — норма). Большое ТЗ сверяется ЧАСТЯМИ (иерархическая
// сегментация): справочник условий повторяется в каждой части, поэтому «весь
// текст в одном контексте» больше не требуется; повторы со стыков и связи между
// разделами снимает финальная межраздельная сверка
// (shared/crossSegmentReview.js). Промт — в stage3Prompts.js.
// Контракт: (context) → Issue[]

const db = require('../../db/connection');
const { getModel } = require('./llm/openaiClient');
const { buildSystemPrompt, resolveVariant } = require('./stage3Prompts');
const {
  defaultsFor,
  renderConditions,
  tenderTypeToContractKind,
} = require('../conditionsRenderer');
const { renderSegment, runLlmStage, buildIssue, locateInBlocks } = require('./shared/llmStage');
const { attachMateriality } = require('./shared/materialityFields');

const RESPONSE_SCHEMA = attachMateriality({
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
            enum: ['противоречит', 'отражено_корректно'],
            description:
              'противоречит — ТЗ затрагивает тему условия и задаёт несовместимое со стандартом компании; отражено_корректно — тема есть и не противоречит (фильтруется). Условия, не затронутые в ТЗ, НЕ возвращай.',
          },
          fragment: {
            type: 'string',
            description:
              'Для status=противоречит — ДОСЛОВНАЯ цитата из ТЗ, которая противоречит условию (обязательна). Для отражено_корректно — пустая строка.',
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
});

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

function buildUserMessage({ tzText, condsText, partIdx, partTotal }) {
  const partNote =
    partTotal > 1
      ? `## ТЗ — часть ${partIdx}/${partTotal} (markdown)\n\nЭто ФРАГМЕНТ ТЗ. Проверяй условия против приведённого ниже ` +
        'текста; остальные части ТЗ проверяются отдельно. Условие, тема которого в этой части ' +
        'не затронута, просто не возвращай (в другой части оно может быть затронуто).'
      : '## ТЗ (markdown, целиком)';
  return [
    partNote,
    '',
    tzText && tzText.trim() ? tzText : '(пусто)',
    '',
    '---',
    '## Существенные условия компании (справочник)',
    '',
    condsText,
    '',
    '---',
    'Пройди условия и найди в тексте ТЗ места, ПРОТИВОРЕЧАЩИЕ условиям компании',
    '(status=противоречит, с дословной цитатой ТЗ). Условия, не затронутые в ТЗ,',
    'не возвращай. Верни в JSON по схеме (поле findings).',
  ].join('\n');
}

// Нормализатор находки Стадии 3 → стандартная находка для buildIssue. Выход —
// только противоречия (status=противоречит с дословной цитатой ТЗ). Всё прочее
// (отражено_корректно, пустая цитата) отбрасывается: без цитаты это не
// «упоминание в ТЗ», а отсутствие темы — не находка Стадии 3.
function makeMapFinding(byName) {
  return function mapFinding(f) {
    if (f.status !== 'противоречит') return null;
    const fragment = (f.fragment || '').trim();
    if (!fragment) return null;
    const name = (f.condition_name || '').trim();
    const cond = byName.get(name) || null;

    return {
      fragment,
      section_path: f.section_path || '',
      problem_type: 'условие_противоречит',
      risk_category: 'существенные_условия',
      criticality: (cond && cond.criticality) || f.criticality || 'high',
      suggested_action: 'replace',
      suggested_redaction: f.suggested_redaction || (cond && cond.text) || null,
      review_comment:
        f.review_comment ||
        `ТЗ противоречит существенному условию компании «${name}». Вынести на рассмотрение / привести в соответствие.`,
      basis: f.basis || `ТЗ противоречит стандартному условию компании «${name}».`,
      confidence: typeof f.confidence === 'number' ? f.confidence : 0.7,
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
  const promptVariant = resolveVariant();
  const systemMsg = buildSystemPrompt(promptVariant);
  // eslint-disable-next-line no-console
  console.log(
    `[stage3_llm] model=${getModel()} promptVariant=${promptVariant} blocks=${blocks.length} условий: ${conds.length}`,
  );
  if (!conds.length) {
    const issues = [];
    issues.analysisNote = 'Нет существенных условий для этого тендера — Стадия 3 пропущена.';
    return issues;
  }

  const condsText = formatConditions(conds);
  const byName = new Map(conds.map((c) => [c.name, c]));
  const tzBudget = CHAR_BUDGET - condsText.length - SCAFFOLD_OVERHEAD - systemMsg.length;
  if (tzBudget <= 0) {
    const err = new Error('Справочник условий превышает бюджет контекста.');
    err.status = 400;
    throw err;
  }

  return runLlmStage(context, {
    sourceDocumentId: context.sourceDocumentId,
    systemMsg,
    schema: RESPONSE_SCHEMA,
    schemaName: 'stage3_findings',
    tzBudget,
    concurrency: 1,
    riskCategory: 'существенные_условия',
    issueDefaults: { suggestedAction: 'replace', confidence: 0.7 },
    logTag: 'stage3_llm',
    keepUnlocated: false,
    mapFinding: makeMapFinding(byName),
    buildUserMessage: (segment, partIdx, partTotal) =>
      buildUserMessage({ tzText: renderSegment(segment), condsText, partIdx, partTotal }),
  });
}

module.exports = { runStage3Llm, buildIssue, locateInBlocks };
