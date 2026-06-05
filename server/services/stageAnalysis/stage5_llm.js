'use strict';

// Стадия 5 — LLM-агент в НОВОЙ роли: self-analysis как quality-control над
// итогом анализа. Вход — исходный ТЗ + готовые КЛАСТЕРЫ замечаний (а не «текст
// ТЗ с нуля»). Агент отвечает на 4 вопроса о качестве сборки:
//   missed_coverage · weak_cluster · cluster_contradiction · needs_enrichment.
//
// Здесь только Stage-5-специфика LLM-вызова: схема ответа, сериализация входа,
// единый вызов модели. Оркестрация (загрузка кластеров/сигналов/ТЗ, эвристики,
// запись self_analysis_results) — в services/selfAnalysis/selfAnalysisService.js.
// Промт (роль QC + 4 вопроса + режимы) — в stage5Prompts.js.

const { chatJson, getModel } = require('./llm/openaiClient');
const { buildSystemPrompt, resolveVariant } = require('./stage5Prompts');

const FINDING_TYPES = ['missed_coverage', 'weak_cluster', 'cluster_contradiction', 'needs_enrichment'];

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['finding_type', 'cluster_id', 'comment', 'suggested_improvement', 'confidence'],
        properties: {
          finding_type: { type: 'string', enum: FINDING_TYPES },
          cluster_id: {
            type: 'string',
            description:
              'Точный id кластера из переданного списка, к которому относится замечание. ' +
              'Пустая строка для missed_coverage (замечание про весь ТЗ / пропуск).',
          },
          comment: { type: 'string', description: 'Что именно не так с разбором (на русском).' },
          suggested_improvement: {
            type: 'string',
            description: 'Как улучшить итог: чем дополнить кластер / что добавить в разбор.',
          },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
  },
  required: ['findings'],
};

// Бюджет на текст ТЗ в user-сообщении (QC не сегментирует ТЗ — даём целиком
// с усечением, кластеры важнее полного текста).
const TZ_CHAR_BUDGET = Number(process.env.STAGE5_TZ_BUDGET) || 200000;

// Компактный дайджест кластера для модели (без шумных полей).
function digestCluster(c) {
  return {
    cluster_id: c.id,
    tz_clause: c.tz_clause || '',
    title: c.cluster_title || '',
    criticality: c.overall_criticality || '',
    problem_type: c.final_problem_type || '',
    semantic_bucket: c.semantic_bucket || '',
    item_count: c.item_count || (Array.isArray(c.items) ? c.items.length : 0),
    basis: c.merged_basis || '',
    recommendation: c.merged_recommendation || '',
  };
}

function buildSelfAnalysisUserMessage({ tzText, clusters, signalStats }) {
  const digest = (clusters || []).map(digestCluster);
  const tz = (tzText || '').trim();
  const tzBlock = tz ? (tz.length > TZ_CHAR_BUDGET ? `${tz.slice(0, TZ_CHAR_BUDGET)}\n…(текст ТЗ усечён)` : tz) : '(пусто)';
  return [
    '## Кластеры замечаний (итог конвейера) — JSON',
    '',
    '```json',
    JSON.stringify(digest, null, 2),
    '```',
    '',
    '## Статистика сигналов',
    '',
    '```json',
    JSON.stringify(signalStats || {}, null, 2),
    '```',
    '',
    '## Исходный ТЗ (markdown)',
    '',
    tzBlock,
    '',
    '---',
    'Проверь ПОЛНОТУ и КАЧЕСТВО разбора (не ищи замечания в тексте заново):',
    'что могли пропустить (missed_coverage), где кластеры слабые (weak_cluster),',
    'где противоречие между кластерами (cluster_contradiction), где усилить',
    'basis/review_comment/suggested_redaction (needs_enrichment). cluster_id —',
    'точный id из списка выше; для missed_coverage — пустая строка. Верни JSON',
    'по схеме (поле findings).',
  ].join('\n');
}

// Единый вызов модели. Возвращает СЫРОЙ массив находок (нормализацию/привязку к
// cluster_id и запись делает selfAnalysisService). Best-effort: при пустом
// списке кластеров проверять нечего — не зовём модель.
async function runSelfAnalysisLlm({ tzText, clusters, signalStats }) {
  if (!Array.isArray(clusters) || !clusters.length) return [];
  const variant = resolveVariant();
  const system = buildSystemPrompt(variant);
  const user = buildSelfAnalysisUserMessage({ tzText, clusters, signalStats });
  // eslint-disable-next-line no-console
  console.log(`[stage5_self_analysis] model=${getModel()} promptVariant=${variant} clusters=${clusters.length}`);
  const res = await chatJson({
    system,
    user,
    jsonSchema: RESPONSE_SCHEMA,
    schemaName: 'stage5_self_analysis',
  });
  return Array.isArray(res && res.findings) ? res.findings : [];
}

module.exports = {
  FINDING_TYPES,
  RESPONSE_SCHEMA,
  digestCluster,
  buildSelfAnalysisUserMessage,
  runSelfAnalysisLlm,
};
