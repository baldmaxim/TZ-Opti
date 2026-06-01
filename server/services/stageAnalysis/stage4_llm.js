'use strict';

// Стадия 4 — LLM-агент: ТЗ vs библиотека типовых рисков.
// Справочник = эффективные риски тендера (стандартные + кастомные, с учётом
// overlay Да/Нет/auto) из risksService. Модель сканирует ТЗ по сегментам и
// привязывает фрагменты к рискам из справочника. Generic-каркас — в
// shared/llmStage.js. Контракт: (context) → Issue[]

const { getModel } = require('./llm/openaiClient');
const { listForTender } = require('../risksService');
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
            enum: ['comment', 'replace', 'delete', 'remove_from_scope', 'clarify', 'limit_scope', 'assumption'],
          },
          suggested_redaction: {
            type: 'string',
            description: 'Рекомендация по риску (как правило — recommendation из справочника). Может быть пустой.',
          },
          review_comment: {
            type: 'string',
            description: 'Краткий комментарий инженеру (на русском). Может быть пустым.',
          },
          basis: {
            type: 'string',
            description: 'Чем фрагмент ТЗ совпал с риском (кратко).',
          },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
  },
  required: ['findings'],
};

const SYSTEM_PROMPT = [
  'Ты — Руководитель строительства Генподрядчика (ГП). Заказчик прислал текст',
  'ТЗ на СОГЛАСОВАНИЕ. Тебе дана БИБЛИОТЕКА типовых рисков ТЗ на СМР (позиция',
  'компании). Задача: пройти ТЗ и найти фрагменты, которые срабатывают на эти',
  'риски — то есть содержат опасную для ГП формулировку из библиотеки.',
  '',
  'КАК РАБОТАТЬ:',
  '• Для каждого риска из справочника пойми его суть (risk_text) и триггеры',
  '  (примеры фраз). Найди в ТЗ фрагменты, которые реально подпадают под риск',
  '  — по смыслу, а не только по точному совпадению слов.',
  '• matched_risk_key — key риска из справочника; risk_category — его category',
  '  (скопируй дословно). criticality бери у риска, если фрагмент явно',
  '  опасен; снижай, если совпадение слабое.',
  '• suggested_redaction — рекомендация компании по этому риску (recommendation',
  '  из справочника), адаптированная к фрагменту.',
  '• fragment — ДОСЛОВНАЯ цитата из приведённого ТЗ, иначе находка',
  '  отбрасывается. problem_type всегда "типовой_риск".',
  '',
  'ЧЕГО НЕ ДЕЛАТЬ:',
  '• Не выдумывай риски вне справочника. Нет совпадения — не флагай.',
  '• Один фрагмент — один (наиболее подходящий) риск, без дублей.',
  '• Не повторяй другие стадии: покрытие расчёта (ВОР/чек-лист) → Стадия 1;',
  '  Q&A → Стадия 2; договорные условия компании → Стадия 3; чистый самоанализ',
  '  формулировок → Стадия 5. Здесь — только совпадения с библиотекой рисков.',
  '',
  'Рассуждай про себя — верни только итоговый JSON (поле findings).',
].join('\n');

const CHAR_BUDGET = Number(process.env.STAGE_LLM_CHAR_BUDGET) || 400000;
const CONCURRENCY = Math.max(1, Number(process.env.STAGE_LLM_CONCURRENCY) || 1);
const SCAFFOLD_OVERHEAD = 600;

function formatRisks(risks) {
  const lines = [];
  risks.forEach((r, i) => {
    const triggers = (r.triggers || []).filter(Boolean).join('; ');
    lines.push(`### ${i + 1}. [${r.key}] (${r.category || '—'}, criticality=${r.criticality || 'medium'})`);
    lines.push(`Риск: ${r.risk_text || '—'}`);
    if (triggers) lines.push(`Триггеры-примеры: ${triggers}`);
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
  // eslint-disable-next-line no-console
  console.log(
    `[stage4_llm] model=${getModel()} blocks=${blocks.length} рисков: ${allRisks.length} → эффективных ${risks.length}`,
  );
  if (!risks.length) {
    const issues = [];
    issues.analysisNote =
      'Нет активных типовых рисков для этого тендера (все отключены в настройке рисков) — Стадия 4 пропущена.';
    return issues;
  }

  const risksText = formatRisks(risks);
  const tzBudget = CHAR_BUDGET - risksText.length - SCAFFOLD_OVERHEAD - SYSTEM_PROMPT.length;
  if (tzBudget <= 0) {
    const err = new Error(
      'Библиотека рисков сама по себе превышает бюджет контекста. Сократите перечень активных рисков.',
    );
    err.status = 400;
    throw err;
  }

  return runLlmStage(context, {
    sourceDocumentId: context.sourceDocumentId,
    systemMsg: SYSTEM_PROMPT,
    schema: RESPONSE_SCHEMA,
    schemaName: 'stage4_findings',
    tzBudget,
    concurrency: CONCURRENCY,
    riskCategory: 'общие_риски',
    issueDefaults: { suggestedAction: 'comment', confidence: 0.7 },
    logTag: 'stage4_llm',
    buildUserMessage: (segBlocks, partIdx, partTotal) =>
      buildSegmentUserMessage({ tzText: renderSegment(segBlocks), risksText, partIdx, partTotal }),
  });
}

module.exports = { runStage4Llm, buildIssue, locateInBlocks };
