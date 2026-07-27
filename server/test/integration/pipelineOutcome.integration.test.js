'use strict';

// Integration: ИСХОД ПРОГОНА КОНВЕЙЕРА ПЕРЕЖИВАЕТ ПЕРЕЗАГРУЗКУ.
//
// Что защищаем: отчёт прогона (статус контракта, предупреждения, причины
// частичного результата, сбойный шаг, шаги, manifest входов, started_at/
// finished_at) пишется в analysis_runs.summary при завершении — и читается
// обратно. Без этого узкая колонка status не различает completed и
// completed_with_warnings, а провалившийся прогон (он не становится указателем)
// после F5 исчезал бы вовсе, и портал показывал бы прежний успешный снимок как
// итог сегодняшней сборки.
//
// Здесь проверяется именно КРУГ ЧЕРЕЗ POSTGRES: пишем прогоном, читаем сырой
// колонкой и через pipelineStatus (новый вызов = состояние после рестарта
// процесса: в памяти вызывающего ничего не осталось).
//
//   npm run test:integration    — без TEST_DATABASE_URL тесты SKIP
//   npm run verify:integration  — без TEST_DATABASE_URL тесты ПАДАЮТ

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { dbTestOptions, getDb, closeDb } = require('../helpers/testDb');
const analysisRuns = require('../../services/analysisRuns/analysisRunsService');
const pipeline = require('../../services/pipeline/analysisPipeline');
const { STATUS } = require('../../services/analysis/resultStatus');

const OPTS = dbTestOptions();
const TENDER_ID = 'pipeline-outcome-tender';

const nowIso = () => new Date().toISOString();

// Раннеры шагов инъектируются: конвейер проверяем без LLM и без реальных слоёв.
const OK_RUNNERS = {
  draft_issues: async () => ({ summary: { draft_issues: 4 } }),
  critic: async () => ({ summary: { reviewed: 4 } }),
  clustering: async () => ({ summary: { clusters: 2 } }),
};

// Полный валидный набор входов: стадии 1–4 completed по текущей ревизии.
async function seedStageSnapshots() {
  const documentsRevisionId = await analysisRuns.currentDocumentsRevision(TENDER_ID);
  const configVersion = analysisRuns.currentConfigVersion();
  const ids = {};
  for (const stage of [1, 2, 3, 4]) {
    // eslint-disable-next-line no-await-in-loop
    const runId = await analysisRuns.beginRun(TENDER_ID, analysisRuns.stageScope(stage), {
      stage, documentsRevisionId, configVersion,
    });
    // eslint-disable-next-line no-await-in-loop
    await analysisRuns.activateRun(TENDER_ID, analysisRuns.stageScope(stage), runId, {
      documentsRevisionId, configVersion,
    });
    ids[stage] = runId;
  }
  return ids;
}

// Сырое чтение колонки: отчёт обязан лежать В БД, а не собираться на лету.
async function readSavedOutcome(db, runId) {
  const row = await db.queryOne('SELECT summary FROM analysis_runs WHERE id = ?', runId);
  assert.ok(row && row.summary, `summary прогона ${runId} не должен быть пустым`);
  const outcome = pipeline.parseRunOutcome(row.summary);
  assert.ok(outcome, 'summary обязан разбираться как отчёт прогона');
  return outcome;
}

async function cleanup(db) {
  await db.queryRun('DELETE FROM analysis_active_runs WHERE tender_id = ?', TENDER_ID);
  for (const t of ['issue_clusters', 'draft_issues', 'issue_reviews', 'self_analysis_results',
    'analysis_signals', 'issues', 'analysis_segments', 'analysis_runs']) {
    // eslint-disable-next-line no-await-in-loop
    await db.queryRun(`DELETE FROM ${t} WHERE tender_id = ?`, TENDER_ID);
  }
}

before(async () => {
  if (OPTS.skip) return;
  const { runMigration } = require('../../db/migrate');
  await runMigration();
  const db = getDb();
  await cleanup(db);
  await db.queryRun('DELETE FROM tenders WHERE id = ?', TENDER_ID);
  await db.queryRun(
    'INSERT INTO tenders (id, title, status, created_at) VALUES (?, ?, ?, ?)',
    TENDER_ID, 'Исход прогона конвейера', 'draft', nowIso(),
  );
});

after(async () => {
  if (OPTS.skip) return;
  const db = getDb();
  await cleanup(db);
  await db.queryRun('DELETE FROM tenders WHERE id = ?', TENDER_ID);
  await closeDb();
});

// --- 1. Успешный прогон --------------------------------------------------------

test('успех: полный отчёт сохранён в analysis_runs.summary и читается обратно', OPTS, async () => {
  const db = getDb();
  await cleanup(db);
  const stageRuns = await seedStageSnapshots();

  const report = await pipeline.runPipeline(TENDER_ID, { withSelfAnalysis: false }, OK_RUNNERS);
  assert.equal(report.status, STATUS.COMPLETED);
  assert.equal(report.activated, true);

  // Сырое чтение колонки.
  const saved = await readSavedOutcome(db, report.run_id);
  assert.equal(saved.status, STATUS.COMPLETED);
  assert.equal(saved.severity, 'success');
  assert.equal(saved.activated, true);
  assert.equal(saved.failed_step, null);
  assert.equal(saved.warnings, null);
  assert.deepEqual(saved.steps.map((s) => s.step), ['draft_issues', 'critic', 'clustering']);
  assert.deepEqual(saved.steps[2].summary, { clusters: 2 });
  assert.deepEqual(
    saved.inputs.manifest.stages.map((s) => s.analysis_run_id),
    [stageRuns[1], stageRuns[2], stageRuns[3], stageRuns[4]],
    'manifest входов сохранён: видно, из каких stage-прогонов собран снимок',
  );
  assert.ok(saved.started_at && saved.finished_at);
  assert.ok(saved.finished_at >= saved.started_at);

  // Повторное чтение (как после перезагрузки страницы / рестарта процесса).
  const status = await pipeline.pipelineStatus(TENDER_ID);
  assert.equal(status.status, STATUS.COMPLETED);
  assert.equal(status.severity, 'success');
  assert.equal(status.active_run.run_id, report.run_id);
  assert.equal(status.last_run.run_id, report.run_id);
  assert.equal(status.active_run.persisted, true);
  assert.equal(status.active_run.started_at, saved.started_at);
  assert.equal(status.active_run.finished_at, saved.finished_at);
  assert.deepEqual(
    status.stage_inputs.map((s) => s.analysis_run_id),
    [stageRuns[1], stageRuns[2], stageRuns[3], stageRuns[4]],
  );
});

// --- 2. Частичный прогон -------------------------------------------------------

test('частичный: completed_with_warnings и причины partial переживают перезагрузку', OPTS, async () => {
  const db = getDb();
  await cleanup(db);
  await seedStageSnapshots();

  const runners = {
    ...OK_RUNNERS,
    // QC досчитал не все части ТЗ: итог пригоден, но неполон.
    self_analysis: async () => ({
      summary: { findings: 3, partial: true, failed_parts: [{ part: 2 }, { part: 3 }] },
    }),
  };
  const report = await pipeline.runPipeline(TENDER_ID, {}, runners);
  assert.equal(report.status, STATUS.COMPLETED_WITH_WARNINGS);
  assert.equal(report.activated, true, 'частичный итог пригоден — указатель переводится');

  const saved = await readSavedOutcome(db, report.run_id);
  assert.equal(saved.status, STATUS.COMPLETED_WITH_WARNINGS);
  assert.equal(saved.severity, 'warning');
  assert.equal(saved.warnings.length, 1);
  assert.equal(saved.partial[0].step, 'self_analysis');
  assert.equal(saved.partial[0].failed_parts, 2);

  // Узкая колонка знает только 'completed' — статус обязан браться из отчёта.
  const row = await db.queryOne('SELECT status FROM analysis_runs WHERE id = ?', report.run_id);
  assert.equal(row.status, 'completed');

  const status = await pipeline.pipelineStatus(TENDER_ID);
  assert.equal(status.status, STATUS.COMPLETED_WITH_WARNINGS, 'жёлтый исход не превращается в зелёный');
  assert.equal(status.severity, 'warning');
  assert.equal(status.partial[0].step, 'self_analysis');
  assert.equal(status.active_run.run_status, 'completed');
  assert.equal(status.active_run.status, STATUS.COMPLETED_WITH_WARNINGS);
});

// --- 3. Неуспешный прогон ------------------------------------------------------

test('сбой: failed сохранён в прогоне, указатель остался на прежнем успехе', OPTS, async () => {
  const db = getDb();
  await cleanup(db);
  await seedStageSnapshots();

  const good = await pipeline.runPipeline(TENDER_ID, { withSelfAnalysis: false }, OK_RUNNERS);
  assert.equal(good.activated, true);

  const failing = { ...OK_RUNNERS, critic: async () => { throw new Error('critic упал'); } };
  const bad = await pipeline.runPipeline(TENDER_ID, { withSelfAnalysis: false }, failing);
  assert.equal(bad.status, STATUS.FAILED);
  assert.equal(bad.activated, false);
  assert.notEqual(bad.run_id, good.run_id);

  const saved = await readSavedOutcome(db, bad.run_id);
  assert.equal(saved.status, STATUS.FAILED);
  assert.equal(saved.severity, 'error');
  assert.equal(saved.ok, false);
  assert.equal(saved.failed_step, 'critic');
  assert.match(saved.steps.find((s) => s.step === 'critic').error, /critic упал/);
  assert.equal(saved.steps.find((s) => s.step === 'clustering').status, 'skipped');
  assert.ok(saved.inputs.manifest, 'manifest сохраняется и у провалившегося прогона');
  assert.ok(saved.started_at && saved.finished_at);

  // Провал не двигает указатель — но и не прячется: после перезагрузки он виден
  // как исход последней сборки, а под указателем остаётся прежний успех.
  const status = await pipeline.pipelineStatus(TENDER_ID);
  assert.equal(status.status, STATUS.FAILED);
  assert.equal(status.failed_step, 'critic');
  assert.equal(status.last_run.run_id, bad.run_id);
  assert.equal(status.active_run.run_id, good.run_id);
  assert.equal(status.active_run.status, STATUS.COMPLETED);
  assert.equal(await analysisRuns.getActivePipelineRunId(TENDER_ID), good.run_id);
});

// --- 4. Негодные входы: прогона нет, прежний исход не подменяется ---------------

test('входы не годятся: прогон не начинается, сохранённый исход прежнего не трогается', OPTS, async () => {
  const db = getDb();
  await cleanup(db);
  await seedStageSnapshots();
  const good = await pipeline.runPipeline(TENDER_ID, { withSelfAnalysis: false }, OK_RUNNERS);

  // Снимаем указатель стадии 3 — набор входов становится неполным.
  await db.queryRun(
    `DELETE FROM analysis_active_runs WHERE tender_id = ? AND scope = ?`,
    TENDER_ID, analysisRuns.stageScope(3),
  );
  const blocked = await pipeline.runPipeline(TENDER_ID, { withSelfAnalysis: false }, OK_RUNNERS);
  assert.equal(blocked.blocked, 'inputs');
  assert.equal(blocked.run_id, null, 'прогон даже не начинали — записывать нечего');

  const status = await pipeline.pipelineStatus(TENDER_ID);
  assert.equal(status.last_run.run_id, good.run_id, 'последним прогоном остаётся прежний');
  assert.equal(status.status, STATUS.COMPLETED, 'его зафиксированный исход не переписан');
});
