'use strict';

// Транспортный контур: CORS-allowlist, заголовки безопасности, идентификатор
// запроса, ограничение частоты и «немые» ошибки production.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildConfig } = require('../../../security/config');
const { decideCors, effectiveOrigins } = require('../../../middleware/corsPolicy');
const { createRateLimit, createStore } = require('../../../middleware/rateLimit');
const { clientIp, SAFE_ID } = require('../../../middleware/requestContext');
const errorHandler = require('../../../middleware/errorHandler');
const { HttpError } = require('../../../utils/errors');
const { generateRsa, signToken, claims, withApp, stubDb } = require('../../helpers/securityFixtures');

const { publicKey, privateKey } = generateRsa();
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' });
const token = (o = {}) => signToken({ payload: claims(o), key: privateKey, alg: 'RS256' });
const app = (t, env = {}) => withApp(t, { publicKeyPem: PUBLIC_PEM, env, tenantFixtures: { tenders: { 'tender-A': 'tenant-a' } } });

// --- CORS --------------------------------------------------------------------

const corsConfig = (overrides = {}) =>
  buildConfig({ NODE_ENV: 'test', CORS_ALLOWED_ORIGINS: 'https://portal.example.com', ...overrides });

test('CORS: разрешённый источник получает заголовки, чужой — нет', () => {
  const config = corsConfig();
  const ok = decideCors(config, { origin: 'https://portal.example.com', method: 'GET' });
  assert.equal(ok.mode, 'allowed');
  assert.equal(ok.headers['Access-Control-Allow-Origin'], 'https://portal.example.com');
  assert.equal(ok.headers.Vary, 'Origin');

  const evil = decideCors(config, { origin: 'https://evil.example', method: 'GET' });
  assert.equal(evil.mode, 'denied');
  assert.deepEqual(evil.headers, {}, 'чужому источнику CORS-заголовки не выдаются');
});

test('CORS: подстроки и поддомены не считаются совпадением', () => {
  const config = corsConfig();
  for (const origin of [
    'https://portal.example.com.evil.io',
    'https://evil.io/https://portal.example.com',
    'http://portal.example.com',
    'https://sub.portal.example.com',
  ]) {
    assert.equal(decideCors(config, { origin, method: 'GET' }).mode, 'denied', origin);
  }
});

test('CORS: запрос без Origin не блокируется (curl, серверные вызовы)', () => {
  assert.equal(decideCors(corsConfig(), { origin: undefined, method: 'GET' }).mode, 'no-origin');
});

test('CORS: preflight разрешённого источника отвечает 204, чужого — 403', async (t) => {
  const { call } = await app(t);
  const ok = await call('/api/tenders', { method: 'OPTIONS', headers: { origin: 'https://portal.example.com' } });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://portal.example.com');
  assert.match(ok.headers.get('access-control-allow-headers') || '', /Authorization/);

  const denied = await call('/api/tenders', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
});

test('CORS: в production пустой allowlist не подменяется локальным фолбэком', () => {
  assert.deepEqual(effectiveOrigins(buildConfig({ NODE_ENV: 'production' })), []);
  assert.deepEqual(effectiveOrigins(buildConfig({ NODE_ENV: 'development' })), [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ]);
});

// --- заголовки безопасности --------------------------------------------------

test('заголовки безопасности стоят на всех ответах, включая ошибки', async (t) => {
  const { call } = await app(t);
  for (const res of [await call('/api/health'), await call('/api/tenders')]) {
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(res.headers.get('content-security-policy') || '', /default-src 'none'/);
    assert.equal(res.headers.get('x-powered-by'), null, 'express не должен представляться');
  }
});

test('HSTS выдаётся только в production и только поверх https', async (t) => {
  const { call } = await app(t);
  const dev = await call('/api/health', { headers: { 'x-forwarded-proto': 'https' } });
  assert.equal(dev.headers.get('strict-transport-security'), null, 'вне production HSTS не нужен');

  const { securityHeaders } = require('../../../middleware/securityHeaders');
  const prodConfig = buildConfig({ NODE_ENV: 'production' });
  const headers = {};
  const res = { setHeader: (k, v) => (headers[k] = v), removeHeader: () => {} };
  securityHeaders(prodConfig)({ secure: false, headers: { 'x-forwarded-proto': 'https' } }, res, () => {});
  assert.match(headers['Strict-Transport-Security'], /max-age=\d+; includeSubDomains/);
});

// --- идентификатор запроса ---------------------------------------------------

test('X-Request-Id: генерируется, возвращается и попадает в тело ошибки', async (t) => {
  const { call } = await app(t);
  const res = await call('/api/tenders');
  const id = res.headers.get('x-request-id');
  assert.ok(SAFE_ID.test(id), `некорректный id: ${id}`);
  assert.equal(res.body.request_id, id, 'по этому номеру ошибку ищут в логе');
});

test('X-Request-Id: свой принимается, мусорный заменяется', async (t) => {
  const { call } = await app(t);
  const own = await call('/api/health', { headers: { 'x-request-id': 'trace-0123456789' } });
  assert.equal(own.headers.get('x-request-id'), 'trace-0123456789');

  // Значение с пробелами/двоеточиями — валидный HTTP-заголовок, но не id:
  // оно не должно попасть ни в ответ, ни в лог, ни в журнал аудита.
  const junk = await call('/api/health', { headers: { 'x-request-id': 'id with spaces; drop table audit_log' } });
  assert.notEqual(junk.headers.get('x-request-id'), 'id with spaces; drop table audit_log');
  assert.ok(SAFE_ID.test(junk.headers.get('x-request-id')));
});

test('IP клиента берётся из X-Forwarded-For только на доверенное число прокси', () => {
  const socket = { remoteAddress: '10.0.0.1' };

  // Без доверия к прокси заголовок игнорируется целиком.
  const spoofed = { headers: { 'x-forwarded-for': '203.0.113.9' }, socket };
  assert.equal(clientIp(spoofed, 0), '10.0.0.1');

  // Один доверенный прокси: он сам записал адрес клиента — берём его.
  assert.equal(clientIp(spoofed, 1), '203.0.113.9');

  // Клиент дописал свой элемент слева: за пределами доверенных звеньев
  // заголовку веры нет, берётся то, что видел наш прокси.
  const forged = { headers: { 'x-forwarded-for': '1.2.3.4, 203.0.113.9' }, socket };
  assert.equal(clientIp(forged, 1), '203.0.113.9', 'подставленный клиентом адрес не должен побеждать');
  assert.equal(clientIp(forged, 2), '1.2.3.4', 'при двух доверенных прокси — левее на один элемент');
});

// --- ограничение частоты -----------------------------------------------------

test('лимит по IP: превышение отдаёт 429 с Retry-After', async (t) => {
  const { call } = await app(t, { RATE_LIMIT_MAX: '3', RATE_LIMIT_WINDOW_SEC: '60' });
  const statuses = [];
  for (let i = 0; i < 5; i += 1) statuses.push((await call('/api/tenders')).status);
  assert.deepEqual(statuses.slice(0, 3), [401, 401, 401]);
  assert.deepEqual(statuses.slice(3), [429, 429]);

  const limited = await call('/api/tenders');
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal(limited.body.code, 'RATE_LIMITED');
});

test('подбор токена: после серии 401 адрес отсекается', async (t) => {
  const { call } = await app(t, { RATE_LIMIT_MAX: '1000', RATE_LIMIT_AUTH_FAIL_MAX: '3' });
  const bad = 'not.a.token';
  for (let i = 0; i < 5; i += 1) await call('/api/tenders', { token: bad });
  const res = await call('/api/tenders', { token: token() });
  assert.equal(res.status, 429, 'после подбора адрес должен быть отсечён даже с валидным токеном');
});

test('дорогие действия лимитируются по субъекту, а не по адресу', async (t) => {
  const { call } = await app(t, { RATE_LIMIT_MAX: '1000', RATE_LIMIT_ANALYSIS_MAX: '2' });
  stubDb(t, () => undefined);
  const a = token({ sub: 'user-a', roles: ['engineer'] });
  const b = token({ sub: 'user-b', roles: ['engineer'] });

  const run = (tk) => call('/api/tenders/tender-A/stages/1/run', { method: 'POST', token: tk });
  await run(a);
  await run(a);
  assert.equal((await run(a)).status, 429, 'третий запуск того же субъекта — отказ');
  assert.notEqual((await run(b)).status, 429, 'другой субъект лимитом соседа не задет');
});

test('чтения не считаются в лимите анализа', async (t) => {
  const { call } = await app(t, { RATE_LIMIT_MAX: '1000', RATE_LIMIT_ANALYSIS_MAX: '1' });
  stubDb(t, ({ kind }) => (kind === 'queryAll' ? [] : { c: 0 }));
  const tk = token({ roles: ['engineer'] });
  for (let i = 0; i < 5; i += 1) assert.notEqual((await call('/api/tenders', { token: tk })).status, 429);
});

test('таблица счётчиков не растёт бесконечно', () => {
  const store = createStore({ maxKeys: 10 });
  for (let i = 0; i < 100; i += 1) store.hit(`k${i}`, 1000, 5);
  assert.ok(store.size() <= 10, `размер ${store.size()}`);
});

test('выключенный лимитер (вне production) ничего не режет', () => {
  const config = buildConfig({ NODE_ENV: 'development', RATE_LIMIT_ENABLED: '0' });
  const rl = createRateLimit(config);
  let called = 0;
  const res = { setHeader: () => {} };
  for (let i = 0; i < 50; i += 1) rl.byIp({ path: '/api/tenders', method: 'GET', clientIp: '1.1.1.1' }, res, () => (called += 1));
  assert.equal(called, 50);
});

// --- ошибки ------------------------------------------------------------------

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
  };
}

test('production: 5xx не раскрывает внутренности, 4xx сохраняет смысл', (t) => {
  const saved = process.env.NODE_ENV;
  const savedExpose = process.env.ERRORS_EXPOSE_INTERNALS;
  const { resetSecurityConfig } = require('../../../security/config');
  // Тестовый процесс не может стать production через NODE_ENV (сигнал
  // node --test неотключаем) — поэтому проверяем через явный флаг.
  process.env.ERRORS_EXPOSE_INTERNALS = '0';
  resetSecurityConfig();
  t.after(() => {
    process.env.NODE_ENV = saved;
    if (savedExpose === undefined) delete process.env.ERRORS_EXPOSE_INTERNALS;
    else process.env.ERRORS_EXPOSE_INTERNALS = savedExpose;
    resetSecurityConfig();
  });
  const realError = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = realError;
  });

  const res = fakeRes();
  const err = new Error('connect ECONNREFUSED 10.0.0.5:5432 user=postgres password=hunter2');
  errorHandler(err, { requestId: 'req-1' }, res, () => {});
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, errorHandler.GENERIC_500);
  assert.equal(res.body.request_id, 'req-1');
  assert.ok(!JSON.stringify(res.body).includes('hunter2'));
  assert.ok(!JSON.stringify(res.body).includes('10.0.0.5'));
  assert.equal(res.body.stack, undefined);

  const domain = fakeRes();
  const conflict = new HttpError(409, 'Стадия закрыта', { stage: 2 });
  conflict.code = 'STAGE_LOCKED';
  errorHandler(conflict, { requestId: 'req-2' }, domain, () => {});
  assert.equal(domain.statusCode, 409);
  assert.equal(domain.body.error, 'Стадия закрыта');
  assert.deepEqual(domain.body.details, { stage: 2 });
});

test('вне production внутренняя ошибка видна разработчику', (t) => {
  const realError = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = realError;
  });
  const res = fakeRes();
  errorHandler(new Error('boom'), { requestId: 'r' }, res, () => {});
  assert.equal(res.body.error, 'boom');
  assert.ok(Array.isArray(res.body.stack));
});
