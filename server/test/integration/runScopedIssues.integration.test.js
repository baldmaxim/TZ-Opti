'use strict';

// Integration: находки скоупятся по АКТУАЛЬНОМУ прогону (снимку). Повторный
// анализ создаёт НОВЫЙ stage-прогон и архивирует прежний; старые issues из БД не
// удаляются. Без run-скоупа счётчики/выгрузки складывали бы старый и новый
// прогоны (п.5 аудита: повтор не смешивает результаты). Здесь проверяем именно
// фильтр, на котором держатся счётчики тендера и все issue-level чтения.
//
//   npm run test:integration    — без TEST_DATABASE_URL тесты SKIP
//   npm run verify:integration  — без TEST_DATABASE_URL тесты ПАДАЮТ

const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');

const { dbTestOptions, getDb, closeDb } = require('../helpers/testDb');
const analysisRuns = require('../../services/analysisRuns/analysisRunsService');

const OPTS = dbTestOptions();
const TENDER_ID = 'runscope-tender';

async function addIssue(db, id, runId, status = 'pending') {
  await db.queryRun(
    `INSERT INTO issues (id, tender_id, analysis_run_id, analysis_stage, source_fragment, problem_type, criticality, review_status)
     VALUES (?, ?, ?, 1, 'фрагмент', 'не_учтено_в_кп', 'high', ?)`,
    id, TENDER_ID, runId, status,
  );
}

// Считает issues тендера ТЕМ ЖЕ фильтром, что использует tendersController.
async function countActive(db) {
  const rf = await analysisRuns.issuesRunFilter(TENDER_ID, 'i');
  const r = await db.queryOne(`SELECT COUNT(*) AS c FROM issues i WHERE i.tender_id = ?${rf.sql}`, TENDER_ID, ...rf.params);
  return Number(r.c);
}

before(async () => {
  if (OPTS.skip) return;
  const { runMigration } = require('../../db/migrate');
  await runMigration();
  const db = getDb();
  await db.queryRun('DELETE FROM tenders WHERE id = ?', TENDER_ID);
  await db.queryRun(
    'INSERT INTO tenders (id, title, status, created_at) VALUES (?, ?, ?, ?)',
    TENDER_ID, 'Run-scope issues', 'draft', new Date().toISOString(),
  );
});

after(async () => {
  if (OPTS.skip) return;
  const db = getDb();
  await db.queryRun('DELETE FROM tenders WHERE id = ?', TENDER_ID);
  await db.queryRun('DELETE FROM analysis_active_runs WHERE tender_id = ?', TENDER_ID);
  await closeDb();
});

test('нет активного прогона → issuesRunFilter даёт заведомо пустой скоуп (0 находок)', OPTS, async () => {
  const db = getDb();
  await addIssue(db, 'rs-orphan', null); // issue без прогона (легаси/сирота)
  assert.equal(await countActive(db), 0, 'без активного stage-прогона находки не считаются');
});

test('повторный анализ: счёт идёт по актуальному прогону, старый прогон не суммируется', OPTS, async () => {
  const db = getDb();
  await db.queryRun('DELETE FROM issues WHERE tender_id = ?', TENDER_ID);

  // Прогон A: 2 находки, активируем.
  const runA = await analysisRuns.beginRun(TENDER_ID, analysisRuns.stageScope(1), { stage: 1 });
  await addIssue(db, 'rs-a1', runA);
  await addIssue(db, 'rs-a2', runA);
  await analysisRuns.activateRun(TENDER_ID, analysisRuns.stageScope(1), runA, {});
  assert.equal(await countActive(db), 2, 'после первого прогона видно 2 находки');

  // Прогон B (повтор): 3 находки, активируем — прежний архивируется.
  const runB = await analysisRuns.beginRun(TENDER_ID, analysisRuns.stageScope(1), { stage: 1 });
  await addIssue(db, 'rs-b1', runB);
  await addIssue(db, 'rs-b2', runB);
  await addIssue(db, 'rs-b3', runB);
  await analysisRuns.activateRun(TENDER_ID, analysisRuns.stageScope(1), runB, {});

  // Физически в БД лежат все 5 issues (снимки не удаляются)…
  const raw = await db.queryOne('SELECT COUNT(*) AS c FROM issues WHERE tender_id = ?', TENDER_ID);
  assert.equal(Number(raw.c), 5, 'старый снимок из БД не удаляется');
  // …но активный скоуп показывает ТОЛЬКО прогон B (3), а не 5.
  assert.equal(await countActive(db), 3, 'повтор не смешивает старые и новые находки');
});
