'use strict';

// Integration: миграция идемпотентна не только на ПУСТОЙ базе (это проверяет
// db.integration.test.js), но и на СУЩЕСТВУЮЩЕЙ базе С ДАННЫМИ, в т.ч. legacy-
// строками, которые появились до колонок снимков (analysis_run_id) и
// изоляции тенантов (tenders.tenant_id). Повторный прогон не должен ни падать,
// ни плодить/ронять данные (п.11 аудита).
//
//   npm run test:integration    — без TEST_DATABASE_URL тесты SKIP
//   npm run verify:integration  — без TEST_DATABASE_URL тесты ПАДАЮТ

const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');

const { dbTestOptions, getDb, closeDb } = require('../helpers/testDb');

const OPTS = dbTestOptions();
const TENDER_ID = 'migpop-tender';

async function countIssues(db) {
  const r = await db.queryOne('SELECT COUNT(*) AS c FROM issues WHERE tender_id = ?', TENDER_ID);
  return Number(r.c);
}

before(async () => {
  if (OPTS.skip) return;
  const { runMigration } = require('../../db/migrate');
  await runMigration(); // схема уже есть — колонки, на которые вставляем ниже
  const db = getDb();
  await db.queryRun('DELETE FROM tenders WHERE id = ?', TENDER_ID);
  const now = new Date().toISOString();
  await db.queryRun(
    'INSERT INTO tenders (id, title, status, created_at) VALUES (?, ?, ?, ?)',
    TENDER_ID, 'Миграция на населённой БД', 'draft', now,
  );
  // Документ + характеристика (проверяем идемпотентные ALTER/backfill колонок).
  await db.queryRun(
    `INSERT INTO documents (id, tender_id, doc_type, name, file_path, uploaded_at, processing_status)
     VALUES (?, ?, 'tz', 'ТЗ.md', '/tmp/tz.md', ?, 'extracted')`,
    'migpop-doc', TENDER_ID, now,
  );
  await db.queryRun(
    'INSERT INTO characteristics (id, tender_id, name, value) VALUES (?, ?, ?, ?)',
    'migpop-char', TENDER_ID, 'Класс бетона', 'B25',
  );
  // Legacy-issue БЕЗ analysis_run_id (как до появления снимков анализа).
  await db.queryRun(
    `INSERT INTO issues (id, tender_id, analysis_stage, source_fragment, problem_type, criticality, review_status)
     VALUES (?, ?, 1, 'Демонтаж не учтён', 'не_учтено_в_кп', 'high', 'pending')`,
    'migpop-issue', TENDER_ID,
  );
  // Legacy issue-level решение по этому issue.
  await db.queryRun(
    `INSERT INTO review_decisions (id, issue_id, decision, decided_at) VALUES (?, ?, 'accept', ?)`,
    'migpop-dec', 'migpop-issue', now,
  );
});

after(async () => {
  if (OPTS.skip) return;
  const db = getDb();
  await db.queryRun('DELETE FROM tenders WHERE id = ?', TENDER_ID);
  await closeDb();
});

test('runMigration на населённой БД (legacy-данные) идемпотентна: два повторных прогона', OPTS, async () => {
  const { runMigration } = require('../../db/migrate');
  const db = getDb();

  const issuesBefore = await countIssues(db);
  assert.equal(issuesBefore, 1, 'исходно один legacy-issue');

  // Повторные прогоны на уже населённой базе не должны ни падать, ни менять данные.
  await runMigration();
  await runMigration();

  assert.equal(await countIssues(db), 1, 'миграция не должна дублировать/удалять issues');

  // Идемпотентные ALTER действительно добавили колонки снимков/происхождения.
  const cols = await db.queryAll(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'issues'`,
  );
  assert.ok(cols.map((c) => c.column_name).includes('analysis_run_id'));

  const docCols = await db.queryAll(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'documents'`,
  );
  const docColNames = docCols.map((c) => c.column_name);
  for (const c of ['sha256', 'size_bytes', 'av_status', 'uploaded_by', 'import_report']) {
    assert.ok(docColNames.includes(c), `documents.${c} должна существовать после миграции`);
  }

  // tenders.tenant_id — NOT NULL с DEFAULT: существующий тендер получил тенант,
  // строка не осталась «ничьей».
  const t = await db.queryOne('SELECT tenant_id FROM tenders WHERE id = ?', TENDER_ID);
  assert.ok(t.tenant_id, 'существующий тендер должен иметь tenant_id после миграции');

  // Legacy-решение по issue не потеряно.
  const dec = await db.queryOne('SELECT decision FROM review_decisions WHERE id = ?', 'migpop-dec');
  assert.equal(dec.decision, 'accept');
});
