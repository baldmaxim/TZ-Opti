'use strict';

// Integration: карта сопоставления «требование ТЗ ↔ позиции ВОР» на живом
// PostgreSQL.
//   npm run test:integration    — без TEST_DATABASE_URL тесты SKIP
//   npm run verify:integration  — без TEST_DATABASE_URL тесты ПАДАЮТ
//
// Контракт хранения: снимок скоуплен прогоном Стадии 1 (идемпотентная запись),
// чтение — по активному указателю, подтверждение инженера переживает новый
// прогон (ключ — стабильный хэш цитаты требования).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { dbTestOptions, getDb, closeDb } = require('../helpers/testDb');
const analysisRuns = require('../../services/analysisRuns/analysisRunsService');
const svc = require('../../services/vor/requirementMatchService');
const { matchKeyOf } = require('../../services/vor/requirementMatchModel');

const OPTS = dbTestOptions();
const TENDER_ID = 'req-match-int-tender';
const FRAGMENT = 'устройство перегородок, усиление проёмов, закладные и заделка примыканий';

const ROWS = [{
  match_key: matchKeyOf(FRAGMENT),
  requirement_fragment: FRAGMENT,
  section_path: '4. Отделка',
  coverage_status: 'partial',
  problem_type: 'учтено_частично',
  positions: [{ position_no: '14', name: 'Перегородки из ПГП', quantity: 12000, unit: 'м2', verified: true, unit_mismatch: false }],
  operations_included: ['устройство перегородок'],
  operations_missing: ['усиление проёмов', 'закладные', 'заделка примыканий'],
  exclusions: [],
  unit_note: null,
  quantity_note: 'объём агрегирован',
  confidence: 0.8,
}];

async function makeStage1Run() {
  const runId = await analysisRuns.beginRun(TENDER_ID, analysisRuns.stageScope(1), {
    stage: 1, documentsRevisionId: 'docs_rm', configVersion: 'cfg_rm',
  });
  await analysisRuns.activateRun(TENDER_ID, analysisRuns.stageScope(1), runId, {
    documentsRevisionId: 'docs_rm', configVersion: 'cfg_rm',
  });
  return runId;
}

before(async () => {
  if (OPTS.skip) return;
  const { runMigration } = require('../../db/migrate');
  await runMigration();
  const db = getDb();
  await db.queryRun('DELETE FROM tenders WHERE id = ?', TENDER_ID);
  await db.queryRun(
    'INSERT INTO tenders (id, title, status, created_at) VALUES (?, ?, ?, ?)',
    TENDER_ID, 'Карта ТЗ↔ВОР: integration-тест', 'draft', new Date().toISOString(),
  );
});

after(async () => {
  if (OPTS.skip) return;
  const db = getDb();
  await db.queryRun('DELETE FROM tenders WHERE id = ?', TENDER_ID).catch(() => {});
  await closeDb();
});

test('снимок карты: запись в прогон, чтение по указателю, идемпотентный повтор', OPTS, async () => {
  const runId = await makeStage1Run();
  await svc.saveMatches(TENDER_ID, runId, ROWS);
  await svc.saveMatches(TENDER_ID, runId, ROWS); // повтор — не дубли

  const map = await svc.getMatches(TENDER_ID);
  assert.equal(map.run_id, runId);
  assert.equal(map.items.length, 1);
  const it = map.items[0];
  assert.equal(it.coverage_status, 'partial');
  assert.deepEqual(it.operations_missing, ['усиление проёмов', 'закладные', 'заделка примыканий']);
  assert.equal(it.positions[0].quantity, 12000);
  assert.equal(it.confirmation, null);
  assert.deepEqual(map.summary, { partial: 1, confirmed: 0 });
});

test('подтверждение инженера переживает новый прогон Стадии 1', OPTS, async () => {
  await svc.setConfirmation(TENDER_ID, matchKeyOf(FRAGMENT), {
    status: 'rejected', note: 'Позиция не включает усиления — запросить у Заказчика.',
  }, { subject: 'engineer-1', tenantId: 't1' });

  let map = await svc.getMatches(TENDER_ID);
  assert.equal(map.items[0].confirmation.status, 'rejected');

  const run2 = await makeStage1Run();
  await svc.saveMatches(TENDER_ID, run2, ROWS);
  map = await svc.getMatches(TENDER_ID);
  assert.equal(map.run_id, run2);
  assert.equal(map.items[0].confirmation.status, 'rejected', 'решение инженера наложено на новый снимок');

  // Пустой PATCH снимает решение.
  await svc.setConfirmation(TENDER_ID, matchKeyOf(FRAGMENT), {});
  map = await svc.getMatches(TENDER_ID);
  assert.equal(map.items[0].confirmation, null);
});

test('кривой статус подтверждения отклоняется без записи', OPTS, async () => {
  await assert.rejects(
    () => svc.setConfirmation(TENDER_ID, matchKeyOf(FRAGMENT), { status: 'ok' }),
    /Недопустимый статус/,
  );
});
