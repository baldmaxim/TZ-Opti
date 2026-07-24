'use strict';

// Стадия 4 — LLM-агент: ТЗ vs библиотека типовых рисков.
// Справочник = эффективные риски тендера (стандартные + кастомные, с учётом
// overlay Да/Нет/auto) из risksService. Модель сканирует ТЗ по сегментам и ищет
// ПРЯМЫЕ или КОСВЕННЫЕ упоминания рисков, влекущие доп. неоплачиваемые работы /
// финансовые потери ГП, привязывая фрагменты к рискам из справочника.
// Generic-каркас — в shared/llmStage.js. Промт — в stage4Prompts.js.
// Контракт: (context) → Issue[]

const { getModel } = require('./llm/openaiClient');
const { buildSystemPrompt, resolveVariant } = require('./stage4Prompts');
const { listForTender } = require('../risksService');
const { renderSegment, runLlmStage, buildIssue, locateInBlocks } = require('./shared/llmStage');
const { scoreStage4Finding } = require('./stage4Scoring');
const { ALL_ACTIONS } = require('../analysis/actions');

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
          'matched_risk_key',
          'risk_category',
          'criticality',
          'suggested_action',
          'basis',
          'confidence',
        ],
        properties: {
          fragment: {
            type: 'string',
            description: 'Дословная цитата из ТЗ, на которую срабатывает риск.',
          },
          section_path: {
            type: 'string',
            description: 'Путь заголовков ТЗ. Пустая строка, если вне заголовка.',
          },
          problem_type: { type: 'string', enum: ['типовой_риск'] },
          matched_risk_key: {
            type: 'string',
            description: 'key риска из справочника (например R03 или custom:...).',
          },
          risk_category: {
            type: 'string',
            description: 'category сработавшего риска (скопируй из справочника).',
          },
          criticality: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          suggested_action: {
            type: 'string',
            enum: ALL_ACTIONS,
          },
          suggested_redaction: {
            type: 'string',
            description: 'Рекомендация по риску (как правило — recommendation из справочника). Может быть пустой.',
          },
          review_comment: {
            type: 'string',
            description:
              'Практический совет инженеру (на русском): что проверить/как закрыть риск. Для high/critical — обязательно непустой, конкретный.',
          },
          basis: {
            type: 'string',
            description:
              'Обоснование: чем фрагмент совпал с риском И какое КОНКРЕТНОЕ денежное/объёмное/срочное последствие для ГП оно влечёт. Без эконом-последствия находку не давать.',
          },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
  },
  required: ['findings'],
};

const CHAR_BUDGET = Number(process.env.STAGE_LLM_CHAR_BUDGET) || 400000;
const CONCURRENCY = Math.max(1, Number(process.env.STAGE_LLM_CONCURRENCY) || 1);
const SCAFFOLD_OVERHEAD = 600;

function formatRisks(risks) {
  const lines = [];
  risks.forEach((r, i) => {
    const triggers = (r.triggers || []).filter(Boolean).join('; ');
    const negatives = (r.negative_triggers || []).filter(Boolean).join('; ');
    lines.push(`### ${i + 1}. [${r.key}] (${r.category || '—'}, criticality=${r.criticality || 'medium'})`);
    lines.push(`Риск: ${r.risk_text || '—'}`);
    if (triggers) lines.push(`Триггеры-примеры: ${triggers}`);
    if (negatives) lines.push(`Анти-триггеры (НЕ риск, если по смыслу про это — не флагай): ${negatives}`);
    if (r.recommendation) lines.push(`Рекомендация компании: ${r.recommendation}`);
    lines.push('');
  });
  return lines.join('\n').trim();
}

function buildSegmentUserMessage({ tzText, risksText, partIdx, partTotal }) {
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
    '## Библиотека типовых рисков (справочник)',
    '',
    risksText,
    '',
    '---',
    'Найди в приведённой части ТЗ фрагменты, срабатывающие на риски из',
    'справочника. Верни списком в JSON по схеме (поле findings).',
  ].join('\n');
}

async function runStage4Llm(context) {
  const { blocks, tenderId } = context;
  if (!Array.isArray(blocks) || !blocks.length) {
    const err = new Error('ТЗ.md пуст или не парсится. Загрузите корректный .md в слот ТЗ.');
    err.status = 400;
    throw err;
  }

  const allRisks = await listForTender(tenderId);
  const risks = allRisks.filter((r) => r.effective);
  const promptVariant = resolveVariant();
  const systemMsg = buildSystemPrompt(promptVariant);
  // eslint-disable-next-line no-console
  console.log(
    `[stage4_llm] model=${getModel()} promptVariant=${promptVariant} blocks=${blocks.length} рисков: ${allRisks.length} → эффективных ${risks.length}`,
  );
  if (!risks.length) {
    const issues = [];
    issues.analysisNote =
      'Нет активных типовых рисков для этого тендера (все отключены в настройке рисков) — Стадия 4 пропущена.';
    return issues;
  }

  const risksText = formatRisks(risks);
  const tzBudget = CHAR_BUDGET - risksText.length - SCAFFOLD_OVERHEAD - systemMsg.length;
  if (tzBudget <= 0) {
    const err = new Error(
      'Библиотека рисков сама по себе превышает бюджет контекста. Сократите перечень активных рисков.',
    );
    err.status = 400;
    throw err;
  }

  // Quality scoring + negative patterns: отсекаем галлюцинации ключей, срабатывания
  // анти-триггеров и слабые/необоснованные находки до дедупа и локализации.
  const riskByKey = new Map(risks.map((r) => [r.key, r]));
  let droppedScore = 0;
  const mapFinding = (f) => {
    const risk = riskByKey.get(f.matched_risk_key) || null;
    const { score, drop, reason } = scoreStage4Finding({ finding: f, risk });
    if (drop) {
      droppedScore += 1;
      // eslint-disable-next-line no-console
      console.log(`[stage4_llm] отсеяно scoring: ${reason} — ${JSON.stringify((f.fragment || '').slice(0, 80))}`);
      return null;
    }
    // Бейдж % не должен завышать слабые совпадения.
    f.confidence = Math.min(typeof f.confidence === 'number' ? f.confidence : score, score);
    return f;
  };

  const issues = await runLlmStage(context, {
    sourceDocumentId: context.sourceDocumentId,
    systemMsg,
    schema: RESPONSE_SCHEMA,
    schemaName: 'stage4_findings',
    tzBudget,
    concurrency: CONCURRENCY,
    riskCategory: 'общие_риски',
    issueDefaults: { suggestedAction: 'comment', confidence: 0.7 },
    logTag: 'stage4_llm',
    mapFinding,
    buildUserMessage: (segBlocks, partIdx, partTotal) =>
      buildSegmentUserMessage({ tzText: renderSegment(segBlocks), risksText, partIdx, partTotal }),
  });
  // eslint-disable-next-line no-console
  console.log(`[stage4_llm] scoring: отсеяно ${droppedScore}, осталось issues=${issues.length}`);
  return issues;
}

module.exports = { runStage4Llm, buildIssue, locateInBlocks };
