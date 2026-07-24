'use strict';

// Главный тест контура доступа: 401 (кто ты?), 403 (что тебе можно?) и
// межтенантное обращение (чьи это данные?) — через НАСТОЯЩИЙ HTTP, с настоящей
// проверкой подписи токена и настоящей матрицей прав. Без БД и без сети.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  generateRsa,
  signToken,
  claims,
  stubDb,
  withApp,
  fakeAudit,
  ISSUER,
} = require('../../helpers/securityFixtures');

const { publicKey, privateKey } = generateRsa();
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' });

const token = (overrides = {}) => signToken({ payload: claims(overrides), key: privateKey, alg: 'RS256' });

// Тендеры двух организаций + документ, принадлежащий чужому тендеру.
const FIXTURES = {
  tenders: { 'tender-A': 'tenant-a', 'tender-B': 'tenant-b' },
  documents: { 'doc-A': 'tender-A', 'doc-B': 'tender-B' },
  issues: { 'issue-B': 'tender-B' },
  jobs: { 'job-B': 'tender-B' },
};

const app = (t, opts = {}) => withApp(t, { publicKeyPem: PUBLIC_PEM, tenantFixtures: FIXTURES, ...opts });

// --- 401: без токена и с негодным токеном ------------------------------------

test('401: запрос без Authorization', async (t) => {
  const { call } = await app(t);
  const res = await call('/api/tenders');
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'TOKEN_MISSING');
  assert.match(res.headers.get('www-authenticate') || '', /^Bearer/);
  // Причина отказа наружу не раскрывается.
  assert.equal(res.body.error, 'Требуется аутентификация');
});

test('401: испорченная подпись', async (t) => {
  const { call } = await app(t);
  const good = token();
  const tampered = `${good.slice(0, -3)}${good.slice(-3) === 'AAA' ? 'BBB' : 'AAA'}`;
  const res = await call('/api/tenders', { token: tampered });
  assert.equal(res.status, 401);
});

test('401: просроченный токен', async (t) => {
  const { call } = await app(t);
  const res = await call('/api/tenders', { token: token({ ttlSec: -3600 }) });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'TOKEN_EXPIRED');
});

test('401: чужой issuer и чужая audience', async (t) => {
  const { call } = await app(t);
  const wrongIss = await call('/api/tenders', { token: token({ iss: 'https://evil.example' }) });
  assert.equal(wrongIss.status, 401);
  assert.equal(wrongIss.body.code, 'ISS_MISMATCH');

  const wrongAud = await call('/api/tenders', { token: token({ aud: 'another-service' }) });
  assert.equal(wrongAud.status, 401);
  assert.equal(wrongAud.body.code, 'AUD_MISMATCH');
});

test('401: alg=none не принимается', async (t) => {
  const { call } = await app(t);
  const none = signToken({ payload: claims(), alg: 'none' });
  const res = await call('/api/tenders', { token: none });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'ALG_NONE');
});

test('401: HS256, подписанный публичным ключом (alg confusion)', async (t) => {
  const { call } = await app(t);
  const forged = signToken({ payload: claims(), alg: 'HS256', secret: PUBLIC_PEM });
  const res = await call('/api/tenders', { token: forged });
  assert.equal(res.status, 401);
  assert.ok(['ALG_NOT_ALLOWED', 'ALG_KEY_MISMATCH'].includes(res.body.code), `код ${res.body.code}`);
});

test('401: токен, подписанный другим ключом того же алгоритма', async (t) => {
  const { call } = await app(t);
  const other = generateRsa();
  const foreign = signToken({ payload: claims(), key: other.privateKey, alg: 'RS256' });
  const res = await call('/api/tenders', { token: foreign });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'SIGNATURE_INVALID');
});

test('401 не выдаёт наличие ресурса: чужой тендер без токена — тот же ответ, что и несуществующий', async (t) => {
  const { call } = await app(t);
  const existing = await call('/api/tenders/tender-B');
  const missing = await call('/api/tenders/no-such-tender');
  assert.equal(existing.status, 401);
  assert.equal(missing.status, 401);
  assert.deepEqual(
    { ...existing.body, request_id: undefined },
    { ...missing.body, request_id: undefined },
  );
});

// --- 403: роли ---------------------------------------------------------------

test('403: viewer не может создать тендер', async (t) => {
  const { call } = await app(t);
  const res = await call('/api/tenders', { method: 'POST', token: token({ roles: ['viewer'] }), body: { title: 'ТЗ' } });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'INSUFFICIENT_ROLE');
});

test('403: viewer не может запустить анализ и выгрузить .docx', async (t) => {
  const { call } = await app(t);
  const viewer = token({ roles: ['viewer'] });
  const run = await call('/api/tenders/tender-A/stages/1/run', { method: 'POST', token: viewer });
  assert.equal(run.status, 403);
  assert.equal(run.body.code, 'INSUFFICIENT_ROLE');
  const exp = await call('/api/tenders/tender-A/export/docx', { token: viewer });
  assert.equal(exp.status, 403);
});

test('403: manager не решает за инженера и не запускает анализ', async (t) => {
  const { call } = await app(t);
  const manager = token({ roles: ['manager'] });
  const decide = await call('/api/tenders/tender-A/review/clusters/c1/decision', { method: 'POST', token: manager, body: {} });
  assert.equal(decide.status, 403);
  const run = await call('/api/tenders/tender-A/pipeline/run', { method: 'POST', token: manager });
  assert.equal(run.status, 403);
});

test('403: engineer не читает журнал аудита, lead читает', async (t) => {
  const auditStore = fakeAudit();
  const { call } = await app(t, { audit: auditStore });
  stubDb(t, ({ kind }) => (kind === 'queryAll' ? [] : { c: 0 }));

  const asEngineer = await call('/api/audit', { token: token({ roles: ['engineer'] }) });
  assert.equal(asEngineer.status, 403);

  const asLead = await call('/api/audit', { token: token({ roles: ['lead'] }) });
  assert.equal(asLead.status, 200);
});

test('403: неизвестная роль прав не даёт (default deny)', async (t) => {
  const { call } = await app(t);
  const res = await call('/api/tenders/tender-A', { token: token({ roles: ['some-provider-group'] }) });
  // Роль не отобразилась ни в одну известную → субъект вообще не допущен.
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'NO_ROLES');
});

test('403: токен без клейма тенанта', async (t) => {
  const { call } = await app(t);
  const noTenant = signToken({ payload: { ...claims(), tenant_id: undefined }, key: privateKey, alg: 'RS256' });
  const res = await call('/api/tenders', { token: noTenant });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'TENANT_CLAIM_MISSING');
});

test('403: маршрут без правила доступа запрещён (POLICY_UNMATCHED)', async (t) => {
  const { call } = await app(t);
  const res = await call('/api/definitely-not-a-route', { token: token({ roles: ['admin'] }) });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'POLICY_UNMATCHED');
});

// --- межтенантный доступ -----------------------------------------------------

test('межтенантный доступ к тендеру → 403 CROSS_TENANT_DENIED', async (t) => {
  const { call } = await app(t);
  const res = await call('/api/tenders/tender-B', { token: token({ tenant: 'tenant-a', roles: ['admin'] }) });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'CROSS_TENANT_DENIED');
  // Ничего о чужом тендере в ответе нет.
  assert.ok(!JSON.stringify(res.body).includes('tenant-b'));
});

test('межтенантный доступ через дочерние ресурсы (документ, находка, задание) → 403', async (t) => {
  const { call } = await app(t);
  const admin = token({ tenant: 'tenant-a', roles: ['admin'] });
  for (const path of ['/api/documents/doc-B/download', '/api/documents/doc-B/text', '/api/jobs/job-B']) {
    const res = await call(path, { token: admin });
    assert.equal(res.status, 403, `${path} → ${res.status}`);
    assert.equal(res.body.code, 'CROSS_TENANT_DENIED', path);
  }
  const patch = await call('/api/issues/issue-B', { method: 'PATCH', token: admin, body: { comment: 'x' } });
  assert.equal(patch.status, 403);
  assert.equal(patch.body.code, 'CROSS_TENANT_DENIED');
});

test('межтенантное УДАЛЕНИЕ не доходит до БД', async (t) => {
  const { call } = await app(t);
  const calls = stubDb(t, () => ({ changes: 1 }));
  const res = await call('/api/tenders/tender-B', { method: 'DELETE', token: token({ tenant: 'tenant-a', roles: ['lead'] }) });
  assert.equal(res.status, 403);
  assert.equal(calls.filter((c) => /DELETE/i.test(c.sql)).length, 0, 'DELETE не должен был выполниться');
});

test('свой тендер доступен, тот же путь для чужого — запрещён', async (t) => {
  const { call } = await app(t);
  stubDb(t, ({ sql }) => {
    if (/SELECT \* FROM tenders WHERE id/.test(sql)) return { id: 'tender-A', title: 'ТЗ', tenant_id: 'tenant-a' };
    if (/COUNT\(\*\)/.test(sql)) return { c: 0 };
    return undefined;
  });
  const engineerA = token({ tenant: 'tenant-a', roles: ['engineer'] });
  const own = await call('/api/tenders/tender-A', { token: engineerA });
  assert.equal(own.status, 200);
  assert.equal(own.body.id, 'tender-A');

  const foreign = await call('/api/tenders/tender-B', { token: engineerA });
  assert.equal(foreign.status, 403);
});

// Вложенные записи (пункт чек-листа, строка Q&A, свой риск) адресуются id,
// который middleware проверить не может: он знает только тендер из пути.
// Значит, SQL обязан искать ПАРУ (тендер + id) — иначе чужой itemId под своим
// тендером стал бы записью в чужую организацию.
test('чужой id вложенной записи под своим тендером не проходит в SQL', async (t) => {
  const { call } = await app(t);
  // Модель: запись существует, но принадлежит тендеру ЧУЖОГО тенанта.
  // Запрос, ограниченный парой (id + тендер), её не находит; неограниченный —
  // находит и меняет, и тест это ловит.
  const calls = stubDb(t, ({ kind, sql }) => {
    const scoped = /tender_id = \?/.test(sql);
    if (!/work_checklist_items/.test(sql)) return undefined;
    if (kind === 'queryRun') return { changes: scoped ? 0 : 1, rows: [] };
    return scoped ? undefined : { id: 'item-of-tender-B' };
  });
  const engineer = token({ tenant: 'tenant-a', roles: ['engineer'] });

  const patch = await call('/api/tenders/tender-A/checklist/item-of-tender-B', {
    method: 'PATCH',
    token: engineer,
    body: { in_calc: 1 },
  });
  assert.equal(patch.status, 404, 'чужая запись не должна находиться');

  const del = await call('/api/tenders/tender-A/checklist/item-of-tender-B', { method: 'DELETE', token: engineer });
  assert.equal(del.status, 404);

  for (const c of calls.filter((x) => /work_checklist_items/.test(x.sql) && /UPDATE|DELETE/i.test(x.sql))) {
    assert.match(c.sql, /tender_id = \?/, `запрос без ограничения по тендеру: ${c.sql}`);
  }
});

test('несуществующий ресурс своего тенанта → 404, а не 403', async (t) => {
  const { call } = await app(t);
  const res = await call('/api/tenders/no-such-tender', { token: token({ roles: ['engineer'] }) });
  assert.equal(res.status, 404);
});

// --- изоляция в выборках и записи --------------------------------------------

test('список тендеров фильтруется по тенанту токена', async (t) => {
  const { call } = await app(t);
  const calls = stubDb(t, ({ kind }) => (kind === 'queryAll' ? [] : { c: 0 }));
  const res = await call('/api/tenders', { token: token({ tenant: 'tenant-a', roles: ['engineer'] }) });
  assert.equal(res.status, 200);
  const listQuery = calls.find((c) => /FROM tenders/.test(c.sql));
  assert.match(listQuery.sql, /tenant_id = \?/, 'выборка обязана быть ограничена тенантом');
  assert.equal(listQuery.params[0], 'tenant-a');
});

test('создание тендера берёт tenant_id из токена, а не из тела запроса', async (t) => {
  const { call } = await app(t);
  const calls = stubDb(t, ({ sql }) => {
    if (/SELECT \* FROM tenders WHERE id/.test(sql)) return { id: 'new', tenant_id: 'tenant-a' };
    if (/COUNT\(\*\)/.test(sql)) return { c: 0 };
    return undefined;
  });
  const res = await call('/api/tenders', {
    method: 'POST',
    token: token({ tenant: 'tenant-a', roles: ['engineer'] }),
    body: { title: 'Новое ТЗ', tenant_id: 'tenant-b', tenantId: 'tenant-b' },
  });
  assert.equal(res.status, 201);
  const insert = calls.find((c) => /INSERT INTO tenders/.test(c.sql));
  assert.ok(insert, 'вставка должна была произойти');
  assert.ok(insert.sql.includes('tenant_id'), 'tenant_id обязателен в INSERT');
  assert.ok(insert.params.includes('tenant-a'), 'тенант — из токена');
  assert.ok(!insert.params.includes('tenant-b'), 'тенант из тела запроса игнорируется');
});

// --- журнал аудита -----------------------------------------------------------

test('отказы и действия попадают в журнал аудита', async (t) => {
  const auditStore = fakeAudit();
  const { call } = await app(t, { audit: auditStore });
  stubDb(t, ({ kind }) => (kind === 'queryAll' ? [] : { c: 0 }));

  const engineerToken = token({ tenant: 'tenant-a', roles: ['engineer'] });
  await call('/api/tenders'); // 401
  await call('/api/tenders/tender-B', { token: token({ tenant: 'tenant-a', roles: ['admin'] }) }); // 403
  await call('/api/tenders', { token: engineerToken }); // 200

  const denied = auditStore.entries.filter((e) => e.outcome === 'denied');
  assert.equal(denied.length, 2, 'оба отказа должны быть в журнале');
  assert.equal(denied[0].category, 'auth', 'отказ без principal — категория auth');
  assert.match(denied[1].reason || '', /CROSS_TENANT_DENIED/);

  const allowed = auditStore.entries.find((e) => e.outcome === 'allowed');
  assert.equal(allowed.action, 'tender.list');
  assert.equal(allowed.tenantId, 'tenant-a');
  assert.equal(allowed.actorSub, 'user-1');
  assert.deepEqual(allowed.actorRoles, ['engineer']);
  assert.ok(allowed.requestId, 'в записи должен быть request id');
  // Сам токен в журнал не попадает ни целиком, ни частями.
  const dump = JSON.stringify(auditStore.entries);
  assert.ok(!dump.includes(engineerToken), 'токен не должен попасть в журнал');
  assert.ok(!/eyJ[A-Za-z0-9_-]{10,}/.test(dump), 'в журнале не должно быть JWT-подобных строк');
});

test('запуск анализа, решение и выгрузка пишутся с правильной категорией', async (t) => {
  const auditStore = fakeAudit();
  const { call } = await app(t, { audit: auditStore });
  stubDb(t, () => undefined);
  const engineer = token({ tenant: 'tenant-a', roles: ['engineer'] });

  await call('/api/tenders/tender-A/stages/1/run', { method: 'POST', token: engineer });
  await call('/api/tenders/tender-A/review/clusters/c1/decision', { method: 'POST', token: engineer, body: {} });
  await call('/api/tenders/tender-A/export/issues.csv', { token: engineer });

  const byAction = Object.fromEntries(auditStore.entries.map((e) => [e.action, e.category]));
  assert.equal(byAction['stage.run'], 'analysis');
  assert.equal(byAction['review.cluster.decide'], 'decision');
  assert.equal(byAction['export.csv'], 'export');
});

// --- dev-bypass --------------------------------------------------------------

test('dev-bypass не работает без явного разрешения и не существует в production', async (t) => {
  const { call } = await app(t, { env: { AUTH_DEV_BYPASS: '0' } });
  assert.equal((await call('/api/tenders')).status, 401);

  const { buildConfig } = require('../../../security/config');
  const prod = buildConfig({ NODE_ENV: 'production', AUTH_DEV_BYPASS: '1', AUTH_OIDC_ISSUER: ISSUER });
  assert.equal(prod.auth.devBypass.enabled, false, 'в production обход обязан быть выключен');
});

test('dev-bypass вне production пускает без токена', async (t) => {
  const { call } = await app(t, { env: { AUTH_DEV_BYPASS: '1', AUTH_DEV_TENANT: 'tenant-a', AUTH_DEV_ROLES: 'engineer' } });
  stubDb(t, ({ kind }) => (kind === 'queryAll' ? [] : { c: 0 }));
  const res = await call('/api/tenders');
  assert.equal(res.status, 200);

  const me = await call('/api/auth/me');
  assert.equal(me.body.auth_method, 'dev-bypass');
  assert.equal(me.body.tenant_id, 'tenant-a');
});

// --- «кто я» -----------------------------------------------------------------

test('GET /api/auth/me отдаёт роли и права субъекта', async (t) => {
  const { call } = await app(t);
  const res = await call('/api/auth/me', { token: token({ roles: ['engineer'] }) });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.roles, ['engineer']);
  assert.ok(res.body.permissions.includes('decision.write'));
  assert.ok(!res.body.permissions.includes('audit.read'));
  assert.equal(res.body.tenant_id, 'tenant-a');
});
