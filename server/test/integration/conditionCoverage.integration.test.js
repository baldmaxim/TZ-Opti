'use strict';

// Integration: матрица покрытия существенных условий на живом PostgreSQL.
//   npm run test:integration    — без TEST_DATABASE_URL тесты SKIP
//   npm run verify:integration  — без TEST_DATABASE_URL тесты ПАДАЮТ
//
// Проверяем контракт хранения:
//   • снимок покрытия скоуплен прогоном, повторная запись идемпотентна;
//   • чтение идёт по актуальному прогону Стадии 3 (указатель), явный run_id —
//     по конкретному прогону;
//   • override инженера накладывается поверх снимка и переживает новый прогон;
//   • кривые статус/действие отклоняются без записи.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { dbTestOptions, getDb, closeDb } = require('../helpers/testDb');
const analysisRuns = require('../../services/analysisRuns/analysisRunsService');
const coverageService = require('../../services/conditions/coverageService');

const OPTS = dbTestOptions();
const TENDER_ID = 'cond-coverage-int-tender';

const nowIso = () => new Date().toISOString();

const ROWS = [
  { topic_key: 'cond:6', name: 'Авансы', kind: 'condition', status: 'matches', evidence: [{ segment: 0, status: 'соответствует', fragment: 'аванс 20%', section_path: null }], resolution: null, criticality: 'high' },
  { topic_key: 'topic:liability_cap', name: 'Лимит совокупной ответственности', kind: 'topic', status: 'missing', evidence: [], resolution: 'check_contract', criticality: 'high' },
];

async function makeStage3Run(activate = true) {
  const runId = await analysisRuns.beginRun(TENDER_ID, analysisRuns.stageScope(3), {
    stage: 3, documentsRevisionId: 'docs_test', configVersion: 'cfg_test',
  });
  if (activate) {
    await analysisRuns.activateRun(TENDER_ID, analysisRuns.stageScope(3), runId, {
      documentsRevisionId: 'docs_test', configVersion: 'cfg_test',
    });
  }
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
    TENDER_ID, 'Покрытие условий: integration-тест', 'draft', nowIso(),
  );
});

after(async () => {
  if (OPTS.skip) return;
  const db = getDb();
  await db.queryRun('DELETE FROM tenders WHERE id = ?', TENDER_ID).catch(() => {});
  await closeDb();
});

test('снимок покрытия: запись в прогон, чтение по активному указателю, идемпотентный повтор', OPTS, async () => {
  const runId = await makeStage3Run();
  await coverageService.saveCoverage(TENDER_ID, runId, ROWS);
  await coverageService.saveCoverage(TENDER_ID, runId, ROWS); // повтор — не дубли

  const cov = await coverageService.getCoverage(TENDER_ID);
  assert.equal(cov.run_id, runId);
  assert.equal(cov.items.length, 2);
  const missing = cov.items.find((i) => i.topic_key === 'topic:liability_cap');
  assert.equal(missing.status, 'missing');
  assert.equal(missing.resolution, 'check_contract');
  const matched = cov.items.find((i) => i.topic_key === 'cond:6');
  assert.equal(matched.status, 'matches');
  assert.equal(matched.evidence[0].fragment, 'аванс 20%');
  assert.deepEqual(cov.summary, { matches: 1, missing: 1 });
});

test('override инженера: статус и действие поверх снимка, переживает новый прогон', OPTS, async () => {
  await coverageService.setOverride(TENDER_ID, 'topic:liability_cap', {
    status: 'other_document', resolution: 'check_contract', note: 'Есть в проекте договора, п. 12.4',
  }, { subject: 'engineer-1', tenantId: 't1' });

  let cov = await coverageService.getCoverage(TENDER_ID);
  let row = cov.items.find((i) => i.topic_key === 'topic:liability_cap');
  assert.equal(row.status, 'other_document', 'статус инженера главнее агентского');
  assert.equal(row.agent_status, 'missing', 'агентский статус не потерян');
  assert.equal(row.override.note, 'Есть в проекте договора, п. 12.4');

  // Новый прогон Стадии 3 — override остаётся наложенным на новый снимок.
  const run2 = await makeStage3Run();
  await coverageService.saveCoverage(TENDER_ID, run2, ROWS);
  cov = await coverageService.getCoverage(TENDER_ID);
  assert.equal(cov.run_id, run2);
  row = cov.items.find((i) => i.topic_key === 'topic:liability_cap');
  assert.equal(row.status, 'other_document');

  // Пустой PATCH снимает override.
  await coverageService.setOverride(TENDER_ID, 'topic:liability_cap', {});
  cov = await coverageService.getCoverage(TENDER_ID);
  row = cov.items.find((i) => i.topic_key === 'topic:liability_cap');
  assert.equal(row.status, 'missing');
  assert.equal(row.override, null);
});

test('явный run_id читает снимок конкретного прогона (история не теряется)', OPTS, async () => {
  const db = getDb();
  const runs = await db.queryAll(
    `SELECT id FROM analysis_runs WHERE tender_id = ? AND stage = 3 ORDER BY started_at ASC`,
    TENDER_ID,
  );
  assert.ok(runs.length >= 2);
  const cov = await coverageService.getCoverage(TENDER_ID, { runId: runs[0].id });
  assert.equal(cov.run_id, runs[0].id);
  assert.equal(cov.items.length, 2, 'снимок первого прогона на месте');
});

test('кривой статус/действие отклоняются без записи', OPTS, async () => {
  await assert.rejects(
    () => coverageService.setOverride(TENDER_ID, 'cond:6', { status: 'зелёный' }),
    /Недопустимый статус/,
  );
  await assert.rejects(
    () => coverageService.setOverride(TENDER_ID, 'cond:6', { resolution: 'удалить всё' }),
    /Недопустимое действие/,
  );
  const cov = await coverageService.getCoverage(TENDER_ID);
  assert.equal(cov.items.find((i) => i.topic_key === 'cond:6').override, null);
});
