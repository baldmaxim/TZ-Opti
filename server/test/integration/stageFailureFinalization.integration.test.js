'use strict';

// Integration: НЕУСПЕШНЫЙ ИСХОД СТАДИИ (failed | cancelled | interrupted) на
// живой PostgreSQL.
//
//   npm run test:integration    — без TEST_DATABASE_URL тесты SKIP
//   npm run verify:integration  — без TEST_DATABASE_URL тесты ПАДАЮТ
//
// Неуспех завершает ТОТ ЖЕ analysis_run, который был создан ДО запуска LLM
// (onJobSettled → engine.finalizeStageRun): отдельной фиктивной failed-строки
// нет. Финализация атомарна (части ТЗ → прогон → возврат workflow одной
// транзакцией), идемпотентна (повтор ничего не переписывает), указатель
// актуального снимка не трогается, а ошибка ПУБЛИКАЦИИ проходит тем же путём.

// Настройки читаются модулями при загрузке — задаём ДО require() движка.
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
process.env.STAGE_CROSS_SEGMENT_REVIEW = '0'; // без LLM-шага сверки: счёт вызовов детерминирован

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { dbTestOptions, getDb, closeDb } = require('../helpers/testDb');
const { installFakeLlm } = require('../helpers/fakeLlm');
const analysisRuns = require('../../services/analysisRuns/analysisRunsService');
const segmentStore = require('../../services/stageAnalysis/segments/segmentStore');
const stageState = require('../../services/stageAnalysis/stageState');
const engine = require('../../services/stageAnalysis/stageAnalysisEngine');
const stageJob = require('../../services/jobs/handlers/stageAnalysisJob');
const { nowIso } = require('../../utils/ids');

const OPTS = dbTestOptions();
const TENDER_ID = 'stage-failure-tender';

// --- Фикстуры ---------------------------------------------------------------------

const okLlm = () => ({
  findings: [{
    fragment: 'МАРКЕР-УБОРКА',
    problem_type: 'не_учтено_в_вор',
    criticality: 'medium',
    basis: 'работа описана в ТЗ, но не найдена в ведомости',
    review_comment: 'Проверить объём по уборке',
    suggested_action: 'clarify',
    confidence: 0.7,
  }],
});

// Финализатор задания — ровно так его зовёт очередь (job-объект, не строка БД).
const settleJob = (runId, status, error = null) => stageJob.onJobSettled({
  job: {
    id: `job-${status}-${runId}`,
    tender_id: TENDER_ID,
    status,
    analysis_run_id: runId,
    error,
    payload_json: JSON.stringify({ stage: 1, prev_status: 'open' }),
  },
});

const count = async (db, table, runId) => Number((await db.queryOne(
  `SELECT COUNT(*) AS c FROM ${table} WHERE tender_id = ? AND analysis_run_id = ?`,
  TENDER_ID, runId,
)).c);

const stageRuns = async (db) => db.queryAll(
  `SELECT id, status, superseded_at FROM analysis_runs
    WHERE tender_id = ? AND kind = 'stage' AND stage = 1 ORDER BY started_at ASC, id ASC`,
  TENDER_ID,
);

const parseSummary = (run) => (typeof run.summary === 'object' ? run.summary : JSON.parse(run.summary || 'null'));

async function wipeTender(db) {
  for (const t of ['analysis_run_segments', 'analysis_segments', 'analysis_active_runs',
    'analysis_signals', 'issues', 'analysis_runs', 'tender_stage_state']) {
    // eslint-disable-next-line no-await-in-loop
    await db.queryRun(`DELETE FROM ${t} WHERE tender_id = ?`, TENDER_ID);
  }
}

// Исходное состояние неуспеха: успешный АКТИВНЫЙ прогон №1 (fake LLM), затем
// «фоновый» прогон №2 — status='running', стадия 'running', части ТЗ в живых
// статусах (0 completed, 1 running, 2 pending) — как будто воркер умер в работе.
async function beginFailingRun(t, db) {
  await wipeTender(db);
  await engine.getStageState(TENDER_ID);
  installFakeLlm(t, okLlm);
  const first = await engine.runStageInner(TENDER_ID, 1);
  const { runId } = await engine.beginStageRun(TENDER_ID, 1, { reason: 'test.failure' });
  await segmentStore.planRunSegments(runId, TENDER_ID, 1, {
    revisionId: 'rev_fail', segments: [0, 1, 2].map((i) => ({ index: i, inputHash: `f${i}` })),
  });
  await segmentStore.markRunSegmentDone(runId, 0, { count: 1, source: 'llm' });
  await segmentStore.markRunSegmentRunning(runId, 1);
  await db.queryRun(
    `UPDATE tender_stage_state SET stage1_status = 'running', current_stage = 1 WHERE tender_id = ?`,
    TENDER_ID,
  );
  return { firstRunId: first.runId, runId };
}

// --- Жизненный цикл файла ----------------------------------------------------------

before(async () => {
  if (OPTS.skip) return;
  const { runMigration } = require('../../db/migrate');
  await runMigration();
  const db = getDb();
  await wipeTender(db);
  await db.queryRun('DELETE FROM documents WHERE tender_id = ?', TENDER_ID);
  await db.queryRun('DELETE FROM tenders WHERE id = ?', TENDER_ID);
  await db.queryRun(
    'INSERT INTO tenders (id, title, status, created_at) VALUES (?, ?, ?, ?)',
    TENDER_ID, 'Неуспешный исход стадии', 'draft', nowIso(),
  );
  // Обязательный Markdown-вход движка: ТЗ с маркером-цитатой для fake LLM.
  await db.queryRun(
    `INSERT INTO documents (id, tender_id, doc_type, name, file_path, uploaded_at, extracted_text, processing_status)
     VALUES (?, ?, 'tz', ?, ?, ?, ?, 'extracted')`,
    'stage-failure-tz', TENDER_ID, 'ТЗ.md', '/tmp/ТЗ.md', nowIso(),
    [
      '# 1. Требования к производству работ', '',
      '1.1 МАРКЕР-УБОРКА. Подрядчик обеспечивает ежедневную уборку строительной площадки',
      'и вывоз строительного мусора за свой счёт в течение всего срока производства работ.', '',
    ].join('\n'),
  );
});

after(async () => {
  if (OPTS.skip) return;
  const db = getDb();
  await wipeTender(db);
  await db.queryRun('DELETE FROM documents WHERE tender_id = ?', TENDER_ID);
  await db.queryRun('DELETE FROM tenders WHERE id = ?', TENDER_ID);
  await closeDb();
});

// --- Тесты -------------------------------------------------------------------------

test('onJobSettled(failed): тот же прогон → failed, части закрыты, workflow возвращён', OPTS, async (t) => {
  const db = getDb();
  const { firstRunId, runId } = await beginFailingRun(t, db);
  const runsBefore = (await stageRuns(db)).length;

  await settleJob(runId, 'failed', 'модель недоступна: таймаут');

  // Терминальный статус в ТОМ ЖЕ прогоне; фиктивной второй строки нет.
  assert.equal((await stageRuns(db)).length, runsBefore, 'финализация не создаёт новых прогонов');
  const run = await analysisRuns.getRun(runId);
  assert.equal(run.status, 'failed');
  assert.ok(run.finished_at, 'у закрытого прогона есть реальный finished_at');
  const summary = parseSummary(run);
  assert.equal(summary.status, 'failed');
  assert.match(summary.error, /модель недоступна/);
  // failed никогда не выдаётся за completed_with_warnings.
  assert.equal(stageState.classifyStageRun(run), 'failed');

  // Части: считавшаяся → interrupted, недошедшая → skipped, готовая цела.
  const segs = await segmentStore.listRunSegments(TENDER_ID, 1, runId);
  assert.deepEqual(segs.map((s) => s.status), ['completed', 'interrupted', 'skipped']);

  // Workflow возвращён в prevStatus; указатель не тронут.
  assert.equal((await engine.getStageState(TENDER_ID)).stage1_status, 'open');
  assert.equal(await analysisRuns.getActiveStageRunId(TENDER_ID, 1), firstRunId);
});

for (const jobStatus of ['cancelled', 'interrupted']) {
  test(`onJobSettled(${jobStatus}): тот же прогон получает статус «${jobStatus}»`, OPTS, async (t) => {
    const db = getDb();
    const { runId } = await beginFailingRun(t, db);

    await settleJob(runId, jobStatus);

    const run = await analysisRuns.getRun(runId);
    assert.equal(run.status, jobStatus, 'обрыв и отмена — не то же самое, что ошибка анализа');
    assert.ok(run.finished_at);
    const summary = parseSummary(run);
    assert.equal(summary.status, jobStatus);
    assert.match(summary.error, /отменён|оборван/);
    assert.equal(stageState.classifyStageRun(run), jobStatus);

    const segs = await segmentStore.listRunSegments(TENDER_ID, 1, runId);
    assert.deepEqual(segs.map((s) => s.status), ['completed', 'interrupted', 'skipped']);
    assert.equal((await engine.getStageState(TENDER_ID)).stage1_status, 'open');
  });
}

test('ошибка публикации идёт тем же неуспешным путём: частичных данных нет, снимок цел', OPTS, async (t) => {
  const db = getDb();
  await wipeTender(db);
  await engine.getStageState(TENDER_ID);
  installFakeLlm(t, okLlm);
  const first = await engine.runStageInner(TENDER_ID, 1);

  // Прогон задания «перехвачен» во время работы (архивирован конкурентом) —
  // LLM отработает, а ПУБЛИКАЦИЯ обязана упасть на страже неизменяемости.
  const { runId } = await engine.beginStageRun(TENDER_ID, 1, { reason: 'test.publish-failure' });
  await db.queryRun('UPDATE analysis_runs SET superseded_at = ? WHERE id = ?', nowIso(), runId);
  await db.queryRun(
    `UPDATE tender_stage_state SET stage1_status = 'running', current_stage = 1 WHERE tender_id = ?`,
    TENDER_ID,
  );
  await assert.rejects(
    () => engine.runStageInner(TENDER_ID, 1, { runId }),
    (err) => err.code === 'RUN_NOT_WRITABLE',
    'публикация в архивированный прогон обязана упасть',
  );

  // Откат публикации: ни issues, ни signals, ни активации, ни reviewing.
  assert.equal(await count(db, 'issues', runId), 0, 'частичных issues нет');
  assert.equal(await count(db, 'analysis_signals', runId), 0, 'частичных signals нет');
  assert.equal(await analysisRuns.getActiveStageRunId(TENDER_ID, 1), first.runId);
  assert.equal((await engine.getStageState(TENDER_ID)).stage1_status, 'running',
    'до финализатора стадия остаётся running — reviewing клиент не видел');

  // Неуспех проходит через ТОТ ЖЕ финализатор задания.
  await settleJob(runId, 'failed', 'публикация не удалась: прогон перехвачен');
  const run = await analysisRuns.getRun(runId);
  assert.equal(run.status, 'failed');
  assert.equal(parseSummary(run).status, 'failed');
  assert.equal((await engine.getStageState(TENDER_ID)).stage1_status, 'open');
  assert.equal(await analysisRuns.getActiveStageRunId(TENDER_ID, 1), first.runId);
  assert.equal((await analysisRuns.getRun(first.runId)).superseded_at, null);
});

test('повторный onJobSettled идемпотентен: исход, время и части не переписываются', OPTS, async (t) => {
  const db = getDb();
  const { firstRunId, runId } = await beginFailingRun(t, db);

  await settleJob(runId, 'failed', 'первая ошибка');
  const after1 = await analysisRuns.getRun(runId);
  const segs1 = await segmentStore.listRunSegments(TENDER_ID, 1, runId);

  // Повтор — в том числе с ДРУГИМ исходом: победил пришедший первым.
  await settleJob(runId, 'failed', 'вторая ошибка');
  await settleJob(runId, 'cancelled', 'запоздавшая отмена');

  const after2 = await analysisRuns.getRun(runId);
  assert.deepEqual(after2, after1, 'повтор финализатора ничего не переписывает');
  assert.match(parseSummary(after2).error, /первая ошибка/);
  const segs2 = await segmentStore.listRunSegments(TENDER_ID, 1, runId);
  assert.deepEqual(
    segs2.map((s) => ({ status: s.status, finished_at: s.finished_at })),
    segs1.map((s) => ({ status: s.status, finished_at: s.finished_at })),
  );
  assert.equal((await engine.getStageState(TENDER_ID)).stage1_status, 'open');
  assert.equal(await analysisRuns.getActiveStageRunId(TENDER_ID, 1), firstRunId);
});

test('неуспех нового прогона сохраняет старый active pointer и его данные', OPTS, async (t) => {
  const db = getDb();
  const { firstRunId, runId } = await beginFailingRun(t, db);
  const issuesBefore = await count(db, 'issues', firstRunId);
  assert.ok(issuesBefore > 0, 'у старого снимка есть находки');

  await settleJob(runId, 'failed', 'сбой воркера');

  const firstRun = await analysisRuns.getRun(firstRunId);
  assert.equal(await analysisRuns.getActiveStageRunId(TENDER_ID, 1), firstRunId,
    'указатель остаётся на старом снимке');
  assert.equal(firstRun.status, 'completed');
  assert.equal(firstRun.superseded_at, null, 'неуспех не архивирует прежний активный прогон');
  assert.equal(await count(db, 'issues', firstRunId), issuesBefore, 'находки старого снимка целы');
  assert.equal(await count(db, 'analysis_signals', firstRunId), issuesBefore, 'сигналы старого снимка целы');
});
