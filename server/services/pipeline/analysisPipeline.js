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
const { STATUS, severityOf } = require('../analysis/resultStatus');
const analysisRuns = require('../analysisRuns/analysisRunsService');
const qualificationShadow = require('../qualification/qualificationShadowService');
const {
  REQUIRED_STAGES,
  MODE,
  resolveMode,
  buildInputsManifest,
  verifyInputsManifest,
  describeViolations,
  canActivate,
} = require('./pipelineManifest');

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

// --- Сохранённый исход прогона (analysis_runs.summary) -------------------------
//
// Отчёт прогона живёт не только в HTTP-ответе: он целиком пишется в
// analysis_runs.summary при завершении (активация / закрытие без активации /
// провал). Иначе после перезагрузки страницы или рестарта процесса исход
// приходилось бы восстанавливать по узкой колонке status — а она не различает
// completed и completed_with_warnings, не помнит, на каком шаге сбой, из каких
// stage-прогонов собирали и почему итог частичный.
const OUTCOME_KIND = 'pipeline_run';
const OUTCOME_VERSION = 1;

// Причины частичного результата: шаг отработал (done), но неполно (warnings).
// Разворачиваем в самостоятельный список — читателю не нужно повторять логику
// «warnings живут внутри шагов».
function partialReasons(steps) {
  return (steps || [])
    .filter((s) => s && s.status === 'done' && s.warnings)
    .map((s) => {
      const fp = s.summary && Array.isArray(s.summary.failed_parts) ? s.summary.failed_parts.length : null;
      const out = { step: s.step, label: s.label || s.step, reason: s.warnings_reason || 'частичный результат' };
      if (fp != null) out.failed_parts = fp;
      return out;
    });
}

// Полный JSON-отчёт прогона для analysis_runs.summary. Чистая функция: то, что
// возвращает API, и то, что лежит в БД, собирается ОДНИМ кодом — расхождение
// «в ответе warnings, в базе просто completed» невозможно.
function buildRunOutcome(report = {}, { manifest = null, startedAt = null, finishedAt = null } = {}) {
  const steps = Array.isArray(report.steps) ? report.steps : [];
  const partial = partialReasons(steps);
  const status = report.status || STATUS.FAILED;
  return {
    kind: OUTCOME_KIND,
    version: OUTCOME_VERSION,
    status,
    severity: severityOf(status),
    ok: Boolean(report.ok),
    activated: Boolean(report.activated),
    mode: report.mode || MODE.PRODUCTION,
    run_id: report.run_id || null,
    steps_done: report.steps_done ?? steps.filter((s) => s.status === 'done').length,
    steps_total: report.steps_total ?? steps.length,
    failed_step: report.failed_step || null,
    warnings: report.warnings && report.warnings.length ? report.warnings : null,
    partial: partial.length ? partial : null,
    stale_inputs: report.stale_inputs ? true : null,
    blocked: report.blocked || null,
    error: report.error || null,
    steps,
    inputs: {
      ok: Boolean(report.inputs && report.inputs.ok),
      violations: (report.inputs && report.inputs.violations) || null,
      manifest: manifest || null,
    },
    started_at: startedAt || null,
    finished_at: finishedAt || null,
  };
}

// Разбор сохранённого исхода. null — если summary пуст, не JSON или написан не
// оркестратором (легаси-прогоны, backfill-строки миграции): такой прогон не
// выдаём за отчёт, статус для него выводится из колонки status.
function parseRunOutcome(raw) {
  if (raw == null || raw === '') return null;
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch (_e) { return null; }
  }
  if (!obj || typeof obj !== 'object' || obj.kind !== OUTCOME_KIND) return null;
  return obj;
}

// Статус прогона для показа: сохранённый исход — источник истины (в нём живёт
// completed_with_warnings, которого узкая колонка status не знает). Без исхода —
// вывод из колонки, fail-closed (неизвестное → failed). 'running' → null: прогон
// ещё идёт, зафиксированного исхода нет.
function runStatusOf(row, outcome) {
  if (outcome && outcome.status) return outcome.status;
  if (!row) return null;
  switch (row.status) {
    case 'running': return null;
    case 'completed': return STATUS.COMPLETED;
    case STATUS.CANCELLED: return STATUS.CANCELLED;
    case STATUS.INTERRUPTED: return STATUS.INTERRUPTED;
    default: return STATUS.FAILED;
  }
}

// Входные stage-прогоны прогона: из manifest, сохранённого в исходе (а если
// исход не писался — из колонки inputs_manifest).
function runStageInputs(outcome, manifest = null) {
  const m = (outcome && outcome.inputs && outcome.inputs.manifest) || manifest || null;
  if (!m || !Array.isArray(m.stages)) return [];
  return m.stages.map((s) => ({ ...s }));
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

// Ошибка «входы конвейера не годятся» — отдельный класс отказа: собирать нечего
// и повтор сам по себе не поможет (нужно пересчитать стадию), поэтому
// retryable=false для очереди.
function inputsError(verification) {
  const err = new Error(`Сборка конвейера невозможна: ${describeViolations(verification.violations)}`);
  err.status = 409;
  err.code = 'PIPELINE_INPUTS_INVALID';
  err.retryable = false;
  err.violations = verification.violations;
  return err;
}

// Начало прогона: фиксируем MANIFEST входов (точный набор stage-прогонов) и
// создаём новый (пока не активированный) pipeline-прогон. Вынесено отдельным
// шагом, потому что конвейер собирается не только синхронным вызовом, но и
// очередью (задание = задача на шаг, см. jobs/handlers) — manifest пишется в
// строку прогона и потому доживает до финализатора в другом процессе.
//
// В production набор проверяется ДО шагов: не собираем итог из неполного или
// разноревизионного набора (и из старого снимка стадии, чей новый прогон упал).
// В debug-режиме нарушения допускаются — взамен finalize не двигает указатель.
async function beginPipelineRun(tenderId, runs = analysisRuns, opts = {}) {
  const mode = resolveMode(opts);
  const startedAt = new Date().toISOString();
  const documentsRevisionId = await runs.currentDocumentsRevision(tenderId);
  const configVersion = runs.currentConfigVersion();
  const stageInputs = await runs.collectStageInputs(tenderId, REQUIRED_STAGES);
  const manifest = buildInputsManifest({
    stageInputs, documentsRevisionId, configVersion, mode, capturedAt: startedAt,
  });
  const verification = verifyInputsManifest(manifest, { phase: 'begin' });
  if (mode === MODE.PRODUCTION && !verification.ok) throw inputsError(verification);

  const runId = await runs.beginRun(tenderId, runs.SCOPE_PIPELINE, {
    documentsRevisionId, configVersion, inputsManifest: manifest,
  });
  return { runId, documentsRevisionId, configVersion, mode, manifest, startedAt, inputs: verification };
}

// Один шаг конвейера в уже начатый прогон. Бросает при сбое — решение
// «повторить/признать провал» принимает вызывающий (оркестратор или воркер).
async function runPipelineStep(tenderId, runId, key, runners = STEP_RUNNERS) {
  const meta = stepMeta(key);
  const t0 = Date.now();
  const res = await runners[key](tenderId, runId);
  const summary = (res && res.summary) || null;
  // Шаг мог вернуть результат, но контракт (resultStatus) в его summary говорит
  // «не собран» — это сбой шага, даже если исключения не было. Страж против
  // ложного успеха: раньше self-analysis отдавал summary после полного отказа QC.
  if (summary && summary.status === STATUS.FAILED) {
    const err = new Error(summary.llm_reason || `Шаг «${meta.label}» не собран (status=failed)`);
    err.status = err.status || 502;
    throw err;
  }
  // Шаг может дать пригодный, но НЕПОЛНЫЙ результат (self-analysis: часть ТЗ не
  // досчитана либо QC не выполнялся). Это не сбой шага (status='done'), но и не
  // полный успех — помечаем warnings, чтобы свёртка прогона не показала зелёный
  // (п.4 аудита).
  const partial = Boolean(summary && summary.partial);
  const step = { step: key, label: meta.label, status: 'done', ms: Date.now() - t0, summary };
  if (partial) {
    step.warnings = true;
    const fp = summary.failed_parts;
    if (Array.isArray(fp) && fp.length) step.warnings_reason = `не досчитано частей ТЗ: ${fp.length}`;
    else step.warnings_reason = summary.llm_reason || 'частичный результат';
  }
  return step;
}

// Повторная проверка входов ПЕРЕД АКТИВАЦИЕЙ. Manifest берём из строки прогона
// (а не из памяти вызывающего): сборка могла идти задачами в другом процессе.
// Сверяем с ТЕКУЩИМ состоянием — сдвинулся указатель стадии или перезалили
// документы, значит собранный снимок stale и активировать его нельзя.
async function verifyPipelineInputs(tenderId, runId, runs = analysisRuns, manifestHint = null) {
  const manifest = manifestHint || await runs.getRunInputsManifest(runId);
  const stageInputs = await runs.collectStageInputs(
    tenderId,
    (manifest && manifest.required_stages && manifest.required_stages.length)
      ? manifest.required_stages : REQUIRED_STAGES,
  );
  const documentsRevisionId = await runs.currentDocumentsRevision(tenderId);
  return verifyInputsManifest(manifest, { stageInputs, documentsRevisionId, phase: 'activate' });
}

// Время старта прогона. Финализатор может работать в другом процессе (сборка
// идёт задачами очереди), поэтому при отсутствии подсказки берём из строки
// прогона, а последним запасным вариантом — из manifest (он фиксируется в тот же
// момент, что и started_at).
async function resolveStartedAt(runId, ctx, runs, manifest) {
  if (ctx && ctx.startedAt) return ctx.startedAt;
  if (runs && typeof runs.getRun === 'function') {
    const row = await runs.getRun(runId);
    if (row && row.started_at) return row.started_at;
  }
  return (manifest && manifest.captured_at) || null;
}

// Финал прогона. Активация — только когда И шаги прошли, И входы всё те же, И
// режим production. Иначе:
//   • debug-режим  → прогон завершается БЕЗ активации (указатель не двигается);
//   • stale-входы  → прогон failed (stale pipeline не активируется);
//   • сбой шага    → прогон failed.
// Указатель в этих случаях остаётся на прежнем снимке.
//
// Любой из трёх исходов пишет в analysis_runs.summary ПОЛНЫЙ отчёт (buildRunOutcome):
// статус контракта, предупреждения и причины partial, сбойный шаг, шаги, manifest
// входов, started_at/finished_at. Поэтому после перезагрузки страницы или рестарта
// процесса портал показывает тот же исход, а не пересобирает его по догадкам.
async function finalizePipelineRun(tenderId, runId, steps, ctx = {}, runs = analysisRuns) {
  const manifest = ctx.manifest || await runs.getRunInputsManifest(runId);
  const inputs = await verifyPipelineInputs(tenderId, runId, runs, manifest);
  const mode = resolveMode({ mode: ctx.mode || inputs.mode });
  const startedAt = await resolveStartedAt(runId, ctx, runs, manifest);
  const report = {
    ...summarizeRun(steps), steps, run_id: runId, mode,
    inputs: { ok: inputs.ok, violations: inputs.violations.length ? inputs.violations : null },
    activated: false,
  };

  // Шаги прошли, но входы устарели — это НЕ успех прогона: снимок собран из
  // набора, которого больше нет. Сообщаем причину явно (до сборки отчёта в БД,
  // иначе сохранённый исход разошёлся бы с возвращённым).
  const activate = report.ok && mode === MODE.PRODUCTION;
  if (activate && !canActivate(inputs)) {
    report.ok = false;
    report.status = STATUS.FAILED;
    report.stale_inputs = true;
    report.error = `Снимок не активирован: ${describeViolations(inputs.violations)}`;
  } else if (report.ok) {
    report.activated = mode === MODE.PRODUCTION;
  }

  // Один и тот же отчёт уходит и в ответ API, и в analysis_runs.summary.
  const finish = () => {
    const finishedAt = new Date().toISOString();
    report.started_at = startedAt;
    report.finished_at = finishedAt;
    return JSON.stringify(buildRunOutcome(report, { manifest, startedAt, finishedAt }));
  };

  if (report.ok && mode === MODE.DEBUG) {
    // Явная частичная сборка: слои посчитаны и доступны по своему run_id, но
    // основной указатель НЕ трогается — портал продолжает читать прежний снимок.
    await runs.completeRunWithoutActivation(runId, { summary: finish() });
    return report;
  }
  if (report.activated) {
    await runs.activateRun(tenderId, runs.SCOPE_PIPELINE, runId, {
      documentsRevisionId: ctx.documentsRevisionId,
      configVersion: ctx.configVersion,
      summary: finish(),
    });
    return report;
  }

  await runs.failRun(runId, finish());
  return report;
}

// Пересобрать конвейер тендера целиком в ОДИН новый неизменяемый снимок
// (pipeline-прогон). Каждый build* пишет в этот прогон; прошлые прогоны не
// трогаются (архив). По успеху прогон активируется (указатель переводится, старый
// архивируется), при сбое помечается failed и указатель остаётся на прежнем.
// runners/runs инъектируем (по умолчанию боевые) — для офлайн-тестов без БД/LLM.
// shadow — SHADOW-квалификация итоговых замечаний (qualificationShadowService.
// evaluateRunSafe): тоже инъектируется, null отключает.
async function runPipeline(
  tenderId, opts = {}, runners = STEP_RUNNERS, runs = analysisRuns,
  shadow = qualificationShadow.evaluateRunSafe,
) {
  const keys = planSteps(opts);
  const steps = [];
  let failed = false;
  const mode = resolveMode(opts);

  let begun;
  try {
    begun = await beginPipelineRun(tenderId, runs, { mode });
  } catch (e) {
    // Входы не годятся — прогон даже не начинаем (снимка нет, указатель цел).
    // Как и сбой шага, это отчёт, а не HTTP-ошибка.
    if (e.code !== 'PIPELINE_INPUTS_INVALID') throw e;
    return {
      ok: false,
      status: STATUS.FAILED,
      mode,
      steps_done: 0,
      steps_total: keys.length,
      failed_step: null,
      warnings: null,
      blocked: 'inputs',
      activated: false,
      run_id: null,
      error: e.message,
      inputs: { ok: false, violations: e.violations || null },
      steps: keys.map((key) => ({
        step: key, label: stepMeta(key).label, status: 'skipped', reason: 'входы конвейера не годятся',
      })),
    };
  }
  const { runId, documentsRevisionId, configVersion, manifest, startedAt } = begun;

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

  // SHADOW-квалификация итоговых замечаний (требование: gate идёт ПОСЛЕ
  // формирования замечания, но ДО передачи данных клиенту — то есть до
  // активации снимка). Строго best-effort и read-only к production: пишет
  // только в finding_qualifications; сбой gate НЕ меняет исход прогона,
  // не двигает указатель и не трогает состав замечаний.
  if (shadow && steps.some((s) => s.step === 'clustering' && s.status === 'done')) {
    try {
      await shadow(tenderId, runId, { trigger: 'pipeline' });
    } catch (err) {
      // evaluateRunSafe сам глотает ошибки; страховка — на случай инъекции.
      console.error(`[pipeline] shadow-квалификация не выполнена: ${err.message}`);
    }
  }

  return finalizePipelineRun(
    tenderId, runId, steps, { documentsRevisionId, configVersion, mode, manifest, startedAt }, runs,
  );
}

// Развёрнутое описание прогона по строке из analysis_runs: зафиксированный исход
// (summary), статус контракта, предупреждения и причины partial, сбойный шаг,
// входные stage-прогоны. Форма совместима с отчётом runPipeline — клиент рисует
// свежий ответ и прочитанный из БД одним кодом.
async function describeRun(row, runs = analysisRuns) {
  if (!row) return null;
  const outcome = parseRunOutcome(row.summary);
  // Исход не писался (легаси-прогон или прогон ещё идёт) — manifest берём из
  // своей колонки, чтобы входы были видны всё равно.
  const manifest = outcome ? null : await runs.getRunInputsManifest(row.id);
  const status = runStatusOf(row, outcome);
  return {
    run_id: row.id,
    run_status: row.status || null, // узкая колонка БД
    status, // контракт результата (в т.ч. completed_with_warnings)
    severity: status ? severityOf(status) : null,
    mode: (outcome && outcome.mode) || null,
    activated: outcome ? Boolean(outcome.activated) : null,
    ok: outcome ? Boolean(outcome.ok) : null,
    steps_done: (outcome && outcome.steps_done) ?? null,
    steps_total: (outcome && outcome.steps_total) ?? null,
    failed_step: (outcome && outcome.failed_step) || null,
    warnings: (outcome && outcome.warnings) || null,
    partial: (outcome && outcome.partial) || null,
    stale_inputs: (outcome && outcome.stale_inputs) || null,
    blocked: (outcome && outcome.blocked) || null,
    error: (outcome && outcome.error) || null,
    steps: (outcome && outcome.steps) || null,
    inputs: outcome
      ? { ok: Boolean(outcome.inputs && outcome.inputs.ok), violations: (outcome.inputs && outcome.inputs.violations) || null }
      : null,
    stage_inputs: runStageInputs(outcome, manifest),
    started_at: (outcome && outcome.started_at) || row.started_at || null,
    finished_at: (outcome && outcome.finished_at) || row.finished_at || null,
    superseded_at: row.superseded_at || null,
    documents_revision_id: row.documents_revision_id || null,
    config_version: row.config_version || null,
    persisted: Boolean(outcome), // отчёт прочитан из БД, а не восстановлен по колонке status
  };
}

// Статус конвейера тендера:
//   • свежесть слоёв (счётчик + время сборки + stale, сводный needs_rebuild);
//   • active_run — прогон под указателем (то, что читает портал);
//   • last_run — ПОСЛЕДНИЙ прогон оркестратора, в т.ч. неуспешный (провалившийся
//     указателем не становится, но его исход обязан быть виден после перезагрузки);
//   • верхний уровень (status/severity/warnings/…) — исход последнего прогона:
//     ровно тот, что был зафиксирован в analysis_runs.summary при завершении.
// db/реестр инъектируются — статус проверяется офлайн-тестом без Postgres.
async function pipelineStatus(tenderId, runs = analysisRuns, database = db) {
  // Свежесть считаем по АКТУАЛЬНЫМ прогонам: signals — по stage-прогонам,
  // производные слои — по pipeline-прогону.
  const pipelineRunId = await runs.getActivePipelineRunId(tenderId);
  const stageRunIds = await runs.getActiveStageRunIds(tenderId);
  const raw = [];
  for (const l of LAYER_TABLES) {
    let row = { c: 0, built_at: null };
    if (l.key === 'signals') {
      if (stageRunIds.length) {
        const ph = stageRunIds.map(() => '?').join(', ');
        row = await database.queryOne(
          `SELECT COUNT(*) AS c, MAX(created_at) AS built_at FROM ${l.table}
            WHERE tender_id = ? AND analysis_run_id IN (${ph})`,
          tenderId, ...stageRunIds,
        );
      }
    } else if (pipelineRunId) {
      row = await database.queryOne(
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

  const activeRow = pipelineRunId ? await runs.getRun(pipelineRunId) : null;
  const lastRow = await runs.getLatestPipelineRun(tenderId);
  const activeRun = await describeRun(activeRow, runs);
  const lastRun = (lastRow && activeRow && lastRow.id === activeRow.id)
    ? activeRun
    : await describeRun(lastRow, runs);
  const shown = lastRun || activeRun;

  return {
    layers,
    needs_rebuild: layers.some((l) => l.stale),
    active_run: activeRun,
    last_run: lastRun,
    // Зафиксированный исход последней сборки — переживает перезагрузку страницы
    // и рестарт процесса.
    status: shown ? shown.status : null,
    severity: shown ? shown.severity : null,
    warnings: shown ? shown.warnings : null,
    partial: shown ? shown.partial : null,
    failed_step: shown ? shown.failed_step : null,
    stage_inputs: shown ? shown.stage_inputs : [],
  };
}

module.exports = {
  // чистое ядро (офлайн-тесты)
  PIPELINE_STEPS,
  planSteps,
  summarizeRun,
  computeLayerStatus,
  STEP_RUNNERS,
  // сохранённый исход прогона (analysis_runs.summary)
  OUTCOME_KIND,
  OUTCOME_VERSION,
  buildRunOutcome,
  parseRunOutcome,
  partialReasons,
  runStatusOf,
  runStageInputs,
  // контракт входов (реэкспорт — один источник для контроллеров/очереди)
  MODE,
  REQUIRED_STAGES,
  resolveMode,
  // DB
  beginPipelineRun,
  verifyPipelineInputs,
  runPipelineStep,
  finalizePipelineRun,
  runPipeline,
  describeRun,
  pipelineStatus,
};
