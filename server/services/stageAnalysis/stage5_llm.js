'use strict';

// Стадия 5 — LLM-агент: самоанализ ТЗ (скрытые работы / двусмыслия / срок).
// Без внешнего справочника — модель читает только ТЗ. Generic-каркас
// (сегментация/locate/дедуп/раннер) — в shared/llmStage.js. Промт — в
// stage5Prompts.js. Здесь только Stage-5-специфика: схема находки, сборка
// user-сообщения.
//
// Модель работы: скан ТЗ по сегментам (как Стадия 1) — каждая находка дословно
// цитирует фрагмент ТЗ, поэтому всегда локализуется. Контракт: (context) → Issue[]

const { getModel } = require('./llm/openaiClient');
const { buildSystemPrompt, resolveVariant } = require('./stage5Prompts');
const { renderSegment, runLlmStage, buildIssue, locateInBlocks } = require('./shared/llmStage');

const RISK_CATEGORIES = ['объём_и_обязательства', 'юридические_формулировки', 'график'];
const PROBLEM_TYPES = ['скрытые_работы', 'двусмысленная_формулировка', 'влияние_на_срок'];

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
          'risk_category',
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
            description: 'Путь заголовков, например: "1. Введение › 1.2 Объём работ". Пустая строка, если вне заголовка.',
          },
          problem_type: { type: 'string', enum: PROBLEM_TYPES },
          risk_category: { type: 'string', enum: RISK_CATEGORIES },
          criticality: { type: 'string', enum: ['high', 'medium', 'low'] },
          suggested_action: {
            type: 'string',
            enum: ['comment', 'replace', 'delete', 'remove_from_scope', 'clarify', 'limit_scope', 'assumption'],
            description: 'Рекомендация агента; инженер может выбрать своё действие в UI.',
          },
          suggested_redaction: {
            type: 'string',
            description: 'Если suggested_action=replace/limit_scope — текст замены/ограничения. Иначе пустая строка.',
          },
          review_comment: {
            type: 'string',
            description: 'Краткий комментарий инженеру (на русском). Может быть пустым.',
          },
          basis: { type: 'string', description: 'Краткое обоснование, почему это проблема.' },
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

function buildSegmentUserMessage({ tzText, partIdx, partTotal }) {
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
    'Найди в приведённом тексте ТЗ скрытые работы, двусмысленные формулировки и',
    'условия, влияющие на срок. Верни списком в JSON по схеме (поле findings).',
  ].join('\n');
}

async function runStage5Llm(context) {
  const { blocks } = context;
  if (!Array.isArray(blocks) || !blocks.length) {
    const err = new Error('ТЗ.md пуст или не парсится. Загрузите корректный .md в слот ТЗ.');
    err.status = 400;
    throw err;
  }

  const promptVariant = resolveVariant();
  const systemMsg = buildSystemPrompt(promptVariant);
  const tzBudget = CHAR_BUDGET - SCAFFOLD_OVERHEAD - systemMsg.length;
  // eslint-disable-next-line no-console
  console.log(
    `[stage5_llm] model=${getModel()} promptVariant=${promptVariant} blocks=${blocks.length} tzBudget=${tzBudget}ch`,
  );

  return runLlmStage(context, {
    sourceDocumentId: context.sourceDocumentId,
    systemMsg,
    schema: RESPONSE_SCHEMA,
    schemaName: 'stage5_findings',
    tzBudget,
    concurrency: CONCURRENCY,
    issueDefaults: { suggestedAction: 'clarify', confidence: 0.65 },
    logTag: 'stage5_llm',
    buildUserMessage: (segBlocks, partIdx, partTotal) =>
      buildSegmentUserMessage({ tzText: renderSegment(segBlocks), partIdx, partTotal }),
  });
}

module.exports = { runStage5Llm, buildIssue, locateInBlocks };
