'use strict';

// Integration: реальная PostgreSQL по TEST_DATABASE_URL.
//   npm run test:integration          — без TEST_DATABASE_URL тесты SKIP (видно в отчёте)
//   npm run verify:integration        — без TEST_DATABASE_URL тесты ПАДАЮТ (TEST_DB_REQUIRED=1)
// Production DATABASE_URL здесь недоступен by design: цель подключения в
// тестовом процессе резолвится только из TEST_DATABASE_URL (db/connectionTarget.js).
//
// ВНИМАНИЕ: тест применяет схему (runMigration) к указанной БД. Указывайте
// отдельную тестовую базу, а не рабочую.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const { dbTestOptions, getDb, closeDb } = require('../helpers/testDb');
const { resolveConnectionString } = require('../../db/connectionTarget');

const OPTS = dbTestOptions();

after(async () => {
  if (!OPTS.skip) await closeDb();
});

test('подключение идёт в TEST_DATABASE_URL, а не в DATABASE_URL', OPTS, () => {
  const target = resolveConnectionString();
  assert.equal(target, (process.env.TEST_DATABASE_URL || '').trim());
  if (process.env.DATABASE_URL) {
    assert.notEqual(target, process.env.DATABASE_URL.trim());
  }
});

test('SELECT 1 — база отвечает', OPTS, async () => {
  const db = getDb();
  const row = await db.queryOne('SELECT 1 AS ok');
  assert.equal(Number(row.ok), 1);
});

test('плейсхолдеры ?→$n работают на живом соединении', OPTS, async () => {
  const db = getDb();
  const row = await db.queryOne("SELECT ?::int AS a, ?::text AS b", 7, 'x?y');
  assert.equal(Number(row.a), 7);
  assert.equal(row.b, 'x?y');
});

test('runMigration идемпотентна: два прогона подряд без ошибок', OPTS, async () => {
  const { runMigration } = require('../../db/migrate');
  await runMigration();
  await runMigration();

  const db = getDb();
  const tables = await db.queryAll(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'`,
  );
  const names = tables.map((t) => t.table_name);
  for (const required of ['tenders', 'documents', 'issues', 'review_decisions', 'issue_clusters']) {
    assert.ok(names.includes(required), `таблица ${required} должна существовать после миграции`);
  }
});

test('транзакция откатывается при ошибке', OPTS, async () => {
  const db = getDb();
  await assert.rejects(() =>
    db.transaction(async (tx) => {
      await tx.exec('CREATE TEMP TABLE tz_opti_tx_probe (id int)');
      throw new Error('rollback me');
    }),
  );
  const row = await db.queryOne(
    `SELECT to_regclass('pg_temp.tz_opti_tx_probe') IS NULL AS gone`,
  );
  assert.equal(row.gone, true);
});
