'use strict';

// Оркестратор аналитического конвейера: draft_issues → critic → clustering →
// self-analysis одним вызовом вместо четырёх ручных POST.
//
// Слои зависят друг от друга и при пересборке родителя каскадно чистятся
// (ON DELETE CASCADE), поэтому порядок шагов фиксирован, а после сбоя шага
// оставшиеся помечаются skipped — собирать их не из чего. Отчёт прогона
// предсказуем (как у экспорта): каждый шаг = { step, status, ms, summary|error },
// сбой шага не превращается в HTTP-ошибку.
//
// Слой signals оркестратор НЕ пересоздаёт: сигналы пишут стадии 1–4
// (writeSignalsForStage), конвейер собирается из уже накопленных.

const db = require('../../db/connection');
const { buildDraftIssues } = require('../unifiedAnalysis/unifiedIssueBuilder');
const { buildIssueReviews } = require('../critic/criticService');
const { buildClusters } = require('../clustering/clusteringService');
const { buildSelfAnalysis } = require('../selfAnalysis/selfAnalysisService');

// Шаги прогона в порядке зависимости (каждый читает слой предыдущего).
// optional: self-analysis — единственный шаг с LLM-вызовом, нужен не на каждой
// пересборке, поэтому его можно отключить флагом withSelfAnalysis=false.
const PIPELINE_STEPS = [
  { key: 'draft_issues', label: 'Единый анализатор (draft_issues)', optional: false },
  { key: 'critic', label: 'Critic — значимость для ГП', optional: false },
  { key: 'clustering', label: 'Кластеризация замечаний', optional: false },
  { key: 'self_analysis', label: 'Self-analysis — QC итога (Стадия 5)', optional: true },
];

// Слои для статуса свежести — signals добавлены первым элементом как корень
// зависимостей (их пересборка делает stale всё, что ниже).
const LAYER_TABLES = [
  { key: 'signals', table: 'analysis_signals', label: 'Сигналы стадий 1–4' },
  { key: 'draft_issues', table: 'draft_issues', label: 'Draft issues (единый анализатор)' },
  { key: 'critic', table: 'issue_reviews', label: 'Critic (значимость)' },
  { key: 'clustering', table: 'issue_clusters', label: 'Кластеры' },
  { key: 'self_analysis', table: 'self_analysis_results', label: 'Self-analysis (QC)' },
];

// --- Чистое ядро (офлайн-тесты, без БД) --------------------------------------

// Какие шаги войдут в прогон.
function planSteps({ withSelfAnalysis = true } = {}) {
  return PIPELINE_STEPS.filter((s) => withSelfAnalysis || !s.optional).map((s) => s.key);
}

// Свёртка отчёта прогона: ok — все шаги done; failed_step — первый сбой.
function summarizeRun(stepResults) {
  const failed = stepResults.find((s) => s.status === 'failed') || null;
  return {
    ok: !failed && stepResults.length > 0 && stepResults.every((s) => s.status === 'done'),
    steps_done: stepResults.filter((s) => s.status === 'done').length,
    steps_total: stepResults.length,
    failed_step: failed ? failed.step : null,
  };
}

// Свежесть слоёв. layers — массив в порядке зависимости: { key, count, built_at }
// (built_at — ISO-строка, сравнение лексикографическое). Слой stale = требует
// пересборки: пуст при непустом родителе, не пуст при пустом родителе (сирота
// после каскада) или собран РАНЬШЕ родителя (родитель пересобран позже).
function computeLayerStatus(layers) {
  let prev = null;
  const out = layers.map((l) => {
    const count = Number(l.count) || 0;
    const item = { ...l, count, empty: count === 0, stale: false };
    if (prev) {
      item.stale =
        (prev.count > 0 && count === 0) ||
        (prev.count === 0 && count > 0) ||
        Boolean(prev.built_at && l.built_at && l.built_at < prev.built_at);
    }
    prev = item;
    return item;
  });
  return out;
}

// --- Прогон и статус (DB-обвязка) --------------------------------------------

const STEP_RUNNERS = {
  draft_issues: buildDraftIssues,
  critic: buildIssueReviews,
  clustering: buildClusters,
  self_analysis: buildSelfAnalysis,
};

// Пересобрать конвейер тендера целиком (идемпотентно — каждый build* слоя
// перезаписывает свой набор). Возвращает отчёт, не бросает на сбое шага.
async function runPipeline(tenderId, opts = {}) {
  const keys = planSteps(opts);
  const steps = [];
  let failed = false;
  for (const key of keys) {
    const meta = PIPELINE_STEPS.find((s) => s.key === key);
    if (failed) {
      steps.push({ step: key, label: meta.label, status: 'skipped', reason: 'предыдущий шаг не выполнен' });
      continue;
    }
    const t0 = Date.now();
    try {
      const res = await STEP_RUNNERS[key](tenderId);
      steps.push({
        step: key,
        label: meta.label,
        status: 'done',
        ms: Date.now() - t0,
        summary: (res && res.summary) || null,
      });
    } catch (e) {
      failed = true;
      steps.push({ step: key, label: meta.label, status: 'failed', ms: Date.now() - t0, error: e.message });
    }
  }
  return { ...summarizeRun(steps), steps };
}

// Статус свежести слоёв конвейера: счётчик + время последней сборки на слой,
// stale-флаги и сводный needs_rebuild.
async function pipelineStatus(tenderId) {
  const raw = [];
  for (const l of LAYER_TABLES) {
    const row = await db.queryOne(
      `SELECT COUNT(*) AS c, MAX(created_at) AS built_at FROM ${l.table} WHERE tender_id = ?`,
      tenderId,
    );
    raw.push({
      key: l.key,
      label: l.label,
      count: Number(row && row.c) || 0,
      built_at: (row && row.built_at) || null,
    });
  }
  const layers = computeLayerStatus(raw);
  return { layers, needs_rebuild: layers.some((l) => l.stale) };
}

module.exports = {
  // чистое ядро (офлайн-тесты)
  PIPELINE_STEPS,
  planSteps,
  summarizeRun,
  computeLayerStatus,
  // DB
  runPipeline,
  pipelineStatus,
};
