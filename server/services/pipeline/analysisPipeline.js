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
const { STATUS } = require('../analysis/resultStatus');
const analysisRuns = require('../analysisRuns/analysisRunsService');

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
// status — единый контракт результата (resultStatus): полный успех, частичный
// (шаг дал usable, но неполный результат — warnings) либо сбой. Пустой прогон
// (0 шагов) успехом НЕ считается. ok остаётся true при warnings: итог пригоден,
// но НЕ зелёный — портал не рапортует полный успех после недосчёта части (п.4).
function summarizeRun(stepResults) {
  const failed = stepResults.find((s) => s.status === 'failed') || null;
  const allDone = !failed && stepResults.length > 0 && stepResults.every((s) => s.status === 'done');
  const warnings = stepResults.filter((s) => s.status === 'done' && s.warnings).map((s) => ({
    step: s.step, reason: s.warnings_reason || 'частичный результат',
  }));
  const ok = allDone;
  let status = STATUS.FAILED;
  if (allDone) status = warnings.length ? STATUS.COMPLETED_WITH_WARNINGS : STATUS.COMPLETED;
  return {
    ok,
    status,
    steps_done: stepResults.filter((s) => s.status === 'done').length,
    steps_total: stepResults.length,
    failed_step: failed ? failed.step : null,
    warnings: warnings.length ? warnings : null,
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

const stepMeta = (key) => PIPELINE_STEPS.find((s) => s.key === key) || { key, label: key };

// Начало прогона: новый (пока не активированный) pipeline-прогон + контекст
// снимка. Вынесено отдельным шагом, потому что конвейер собирается не только
// синхронным вызовом, но и очередью (задание = задача на шаг, см. jobs/handlers).
async function beginPipelineRun(tenderId, runs = analysisRuns) {
  const documentsRevisionId = await runs.currentDocumentsRevision(tenderId);
  const configVersion = runs.currentConfigVersion();
  const runId = await runs.beginRun(tenderId, runs.SCOPE_PIPELINE, { documentsRevisionId, configVersion });
  return { runId, documentsRevisionId, configVersion };
}

// Один шаг конвейера в уже начатый прогон. Бросает при сбое — решение
// «повторить/признать провал» принимает вызывающий (оркестратор или воркер).
async function runPipelineStep(tenderId, runId, key, runners = STEP_RUNNERS) {
  const meta = stepMeta(key);
  const t0 = Date.now();
  const res = await runners[key](tenderId, runId);
  const summary = (res && res.summary) || null;
  // Шаг может дать пригодный, но НЕПОЛНЫЙ результат (self-analysis: часть ТЗ не
  // досчитана). Это не сбой шага (status='done'), но и не полный успех —
  // помечаем warnings, чтобы свёртка прогона не показала зелёный (п.4 аудита).
  const partial = Boolean(summary && summary.partial);
  const step = { step: key, label: meta.label, status: 'done', ms: Date.now() - t0, summary };
  if (partial) {
    step.warnings = true;
    const fp = summary.failed_parts;
    step.warnings_reason = Array.isArray(fp) && fp.length
      ? `не досчитано частей ТЗ: ${fp.length}`
      : 'частичный результат';
  }
  return step;
}

// Финал прогона: по успеху всех шагов — активация снимка (указатель переводится,
// прежний архивируется), иначе прогон помечается failed, указатель не двигается.
async function finalizePipelineRun(tenderId, runId, steps, ctx = {}, runs = analysisRuns) {
  const report = { ...summarizeRun(steps), steps, run_id: runId };
  if (report.ok) {
    await runs.activateRun(tenderId, runs.SCOPE_PIPELINE, runId, {
      documentsRevisionId: ctx.documentsRevisionId, configVersion: ctx.configVersion,
    });
  } else {
    await runs.failRun(runId, JSON.stringify({ failed_step: report.failed_step }));
  }
  return report;
}

// Пересобрать конвейер тендера целиком в ОДИН новый неизменяемый снимок
// (pipeline-прогон). Каждый build* пишет в этот прогон; прошлые прогоны не
// трогаются (архив). По успеху прогон активируется (указатель переводится, старый
// архивируется), при сбое помечается failed и указатель остаётся на прежнем.
// runners/runs инъектируем (по умолчанию боевые) — для офлайн-тестов без БД/LLM.
async function runPipeline(tenderId, opts = {}, runners = STEP_RUNNERS, runs = analysisRuns) {
  const keys = planSteps(opts);
  const steps = [];
  let failed = false;

  const { runId, documentsRevisionId, configVersion } = await beginPipelineRun(tenderId, runs);

  for (const key of keys) {
    const meta = stepMeta(key);
    if (failed) {
      steps.push({ step: key, label: meta.label, status: 'skipped', reason: 'предыдущий шаг не выполнен' });
      continue;
    }
    const t0 = Date.now();
    try {
      // eslint-disable-next-line no-await-in-loop
      steps.push(await runPipelineStep(tenderId, runId, key, runners));
    } catch (e) {
      failed = true;
      steps.push({ step: key, label: meta.label, status: 'failed', ms: Date.now() - t0, error: e.message });
    }
  }

  return finalizePipelineRun(tenderId, runId, steps, { documentsRevisionId, configVersion }, runs);
}

// Статус свежести слоёв конвейера: счётчик + время последней сборки на слой,
// stale-флаги и сводный needs_rebuild.
async function pipelineStatus(tenderId) {
  // Свежесть считаем по АКТУАЛЬНЫМ прогонам: signals — по stage-прогонам,
  // производные слои — по pipeline-прогону.
  const pipelineRunId = await analysisRuns.getActivePipelineRunId(tenderId);
  const stageRunIds = await analysisRuns.getActiveStageRunIds(tenderId);
  const raw = [];
  for (const l of LAYER_TABLES) {
    let row = { c: 0, built_at: null };
    if (l.key === 'signals') {
      if (stageRunIds.length) {
        const ph = stageRunIds.map(() => '?').join(', ');
        row = await db.queryOne(
          `SELECT COUNT(*) AS c, MAX(created_at) AS built_at FROM ${l.table}
            WHERE tender_id = ? AND analysis_run_id IN (${ph})`,
          tenderId, ...stageRunIds,
        );
      }
    } else if (pipelineRunId) {
      row = await db.queryOne(
        `SELECT COUNT(*) AS c, MAX(created_at) AS built_at FROM ${l.table}
          WHERE tender_id = ? AND analysis_run_id = ?`,
        tenderId, pipelineRunId,
      );
    }
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
  STEP_RUNNERS,
  // DB
  beginPipelineRun,
  runPipelineStep,
  finalizePipelineRun,
  runPipeline,
  pipelineStatus,
};
