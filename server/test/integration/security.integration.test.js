'use strict';

// Integration: изоляция тенантов и журнал аудита на живом PostgreSQL.
//   npm run test:integration    — без TEST_DATABASE_URL тесты SKIP
//   npm run verify:integration  — без TEST_DATABASE_URL тесты ПАДАЮТ
//
// Здесь проверяется то, что нельзя проверить офлайн:
//   • миграция создаёт tenants/audit_log и проставляет tenders.tenant_id;
//   • резолвер тенанта видит НАСТОЯЩИЕ строки (тендер и его документы);
//   • межтенантный доступ отбивается на реальных данных;
//   • запись и чтение журнала аудита работают, чтение ограничено тенантом.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { dbTestOptions, getDb, closeDb } = require('../helpers/testDb');
const { createTenantResolver, assertSameTenant } = require('../../security/tenantAccess');
const audit = require('../../services/audit/auditService');

const OPTS = dbTestOptions();

const TENANT_A = 'sec-int-tenant-a';
const TENANT_B = 'sec-int-tenant-b';
const TENDER_A = 'sec-int-tender-a';
const TENDER_B = 'sec-int-tender-b';
const DOC_B = 'sec-int-doc-b';

const principal = (tenantId) => ({ subject: 'sec-int-user', tenantId, roles: ['admin'] });

before(async () => {
  if (OPTS.skip) return;
  const { runMigration } = require('../../db/migrate');
  await runMigration();
  const db = getDb();
  const now = new Date().toISOString();

  await db.queryRun('DELETE FROM tenders WHERE id IN (?, ?)', TENDER_A, TENDER_B);
  await db.queryRun('DELETE FROM audit_log WHERE tenant_id IN (?, ?)', TENANT_A, TENANT_B);
  for (const id of [TENANT_A, TENANT_B]) {
    await db.queryRun(
      "INSERT INTO tenants (id, name, status, created_at) VALUES (?, ?, 'active', ?) ON CONFLICT (id) DO NOTHING",
      id, id, now,
    );
  }
  for (const [id, tenant] of [[TENDER_A, TENANT_A], [TENDER_B, TENANT_B]]) {
    await db.queryRun(
      'INSERT INTO tenders (id, title, status, created_at, tenant_id) VALUES (?, ?, ?, ?, ?)',
      id, `Тендер ${tenant}`, 'draft', now, tenant,
    );
  }
  await db.queryRun(
    `INSERT INTO documents (id, tender_id, doc_type, name, file_path, uploaded_at, sha256, size_bytes, av_status)
     VALUES (?, ?, 'tz', 'ТЗ.md', '/tmp/tz.md', ?, ?, ?, 'clean')`,
    DOC_B, TENDER_B, now, 'a'.repeat(64), 123,
  );
});

after(async () => {
  if (OPTS.skip) return;
  const db = getDb();
  await db.queryRun('DELETE FROM tenders WHERE id IN (?, ?)', TENDER_A, TENDER_B);
  await db.queryRun('DELETE FROM audit_log WHERE tenant_id IN (?, ?)', TENANT_A, TENANT_B);
  await db.queryRun('DELETE FROM tenants WHERE id IN (?, ?)', TENANT_A, TENANT_B);
  await closeDb();
});

test('миграция: тендер без тенанта невозможен на уровне схемы', OPTS, async () => {
  const db = getDb();
  const defaultTenant = (process.env.SECURITY_DEFAULT_TENANT || 'default').trim();

  const row = await db.queryOne('SELECT id FROM tenants WHERE id = ?', defaultTenant);
  assert.ok(row, 'тенант по умолчанию должен существовать');

  const column = await db.queryOne(
    `SELECT is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'tenders' AND column_name = 'tenant_id'`,
  );
  assert.equal(column.is_nullable, 'NO', 'tenant_id обязан быть NOT NULL');
  assert.match(column.column_default || '', new RegExp(defaultTenant), 'у tenant_id должен быть DEFAULT');

  // Вставка в обход контроллера (сид, служебный скрипт) всё равно получает тенант.
  const id = 'sec-int-default-tenant';
  await db.queryRun('DELETE FROM tenders WHERE id = ?', id);
  await db.queryRun(
    'INSERT INTO tenders (id, title, status, created_at) VALUES (?, ?, ?, ?)',
    id, 'Без явного тенанта', 'draft', new Date().toISOString(),
  );
  const inserted = await db.queryOne('SELECT tenant_id FROM tenders WHERE id = ?', id);
  assert.equal(inserted.tenant_id, defaultTenant);
  await db.queryRun('DELETE FROM tenders WHERE id = ?', id);
});

test('резолвер видит тенант тендера и его дочерних записей', OPTS, async () => {
  const resolver = createTenantResolver({ db: getDb() });

  const tender = await resolver.resolve('tender', { tenderId: TENDER_B });
  assert.equal(tender.found, true);
  assert.equal(tender.tenantId, TENANT_B);

  const doc = await resolver.resolve('document', { documentId: DOC_B });
  assert.equal(doc.found, true);
  assert.equal(doc.tenderId, TENDER_B);
  assert.equal(doc.tenantId, TENANT_B, 'документ наследует тенант своего тендера');

  const missing = await resolver.resolve('tender', { tenderId: 'нет-такого' });
  assert.equal(missing.found, false);
});

test('межтенантное обращение отбивается на реальных данных', OPTS, async () => {
  const resolver = createTenantResolver({ db: getDb() });
  const foreign = await resolver.resolve('document', { documentId: DOC_B });

  assert.throws(() => assertSameTenant(principal(TENANT_A), foreign), (err) => {
    assert.equal(err.status, 403);
    assert.equal(err.code, 'CROSS_TENANT_DENIED');
    return true;
  });
  assert.doesNotThrow(() => assertSameTenant(principal(TENANT_B), foreign));
});

test('журнал аудита: запись, чтение своим тенантом и фильтры', OPTS, async () => {
  await audit.record({
    tenantId: TENANT_A,
    tenderId: TENDER_A,
    actorSub: 'engineer-1',
    actorRoles: ['engineer'],
    action: 'stage.run',
    category: 'analysis',
    outcome: 'allowed',
    method: 'POST',
    path: `/api/tenders/${TENDER_A}/stages/1/run`,
    status: 200,
    requestId: 'int-req-1',
    meta: { stage: 1 },
  });
  await audit.record({
    tenantId: TENANT_A,
    tenderId: TENDER_A,
    actorSub: 'viewer-1',
    actorRoles: ['viewer'],
    action: 'export.docx',
    category: 'export',
    outcome: 'denied',
    status: 403,
    reason: 'INSUFFICIENT_ROLE',
  });
  await audit.record({
    tenantId: TENANT_B,
    tenderId: TENDER_B,
    actorSub: 'engineer-2',
    action: 'tender.get',
    category: 'read',
    outcome: 'allowed',
    status: 200,
  });

  const forA = await audit.list({ tenantId: TENANT_A });
  assert.equal(forA.total, 2, 'видны только записи своего тенанта');
  assert.ok(forA.items.every((i) => i.tenant_id === TENANT_A));
  assert.ok(!JSON.stringify(forA.items).includes('engineer-2'), 'чужие записи не протекают');

  const denied = await audit.list({ tenantId: TENANT_A, outcome: 'denied' });
  assert.equal(denied.total, 1);
  assert.equal(denied.items[0].action, 'export.docx');
  assert.equal(denied.items[0].reason, 'INSUFFICIENT_ROLE');

  const analysis = await audit.list({ tenantId: TENANT_A, category: 'analysis' });
  assert.equal(analysis.items[0].meta, '{"stage":1}');
  assert.equal(analysis.items[0].request_id, 'int-req-1');

  await assert.rejects(() => audit.list({}), /tenantId обязателен/);
});

test('журнал аудита: чистка по сроку хранения удаляет только старое', OPTS, async () => {
  const old = new Date(Date.now() - 400 * 24 * 3600 * 1000).toISOString();
  await audit.record({ tenantId: TENANT_B, action: 'tender.get', category: 'read', outcome: 'allowed', ts: old });

  const before = await audit.list({ tenantId: TENANT_B });
  const removed = await audit.purgeOlderThan(new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString());
  assert.ok(removed >= 1);

  const after = await audit.list({ tenantId: TENANT_B });
  assert.equal(after.total, before.total - 1);
  assert.ok(after.items.every((i) => i.ts > old));
});

test('документ хранит происхождение файла (хэш, размер, вердикт антивируса)', OPTS, async () => {
  const row = await getDb().queryOne('SELECT sha256, size_bytes, av_status FROM documents WHERE id = ?', DOC_B);
  assert.equal(row.sha256.length, 64);
  assert.equal(Number(row.size_bytes), 123);
  assert.equal(row.av_status, 'clean');
});
