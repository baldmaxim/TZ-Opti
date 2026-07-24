'use strict';

// Журнал аудита: нормализация записи (чистая функция) и правила middleware —
// что пишется, что не пишется и что при этом НЕ ломается.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { normalizeEntry, CATEGORIES, OUTCOMES, COLUMNS } = require('../../../services/audit/auditService');
const { auditLogger, outcomeFor } = require('../../../middleware/auditLogger');
const { buildConfig } = require('../../../security/config');

test('исход определяется статусом ответа', () => {
  assert.equal(outcomeFor(200), 'allowed');
  assert.equal(outcomeFor(201), 'allowed');
  assert.equal(outcomeFor(401), 'denied');
  assert.equal(outcomeFor(403), 'denied');
  assert.equal(outcomeFor(429), 'denied');
  assert.equal(outcomeFor(404), 'error');
  assert.equal(outcomeFor(500), 'error');
});

test('запись приводится к колонкам таблицы, лишнее обрезается', () => {
  const row = normalizeEntry({
    action: 'stage.run',
    category: 'analysis',
    outcome: 'allowed',
    actorRoles: ['engineer', 'lead'],
    tenantId: 'tenant-a',
    status: 200.7,
    durationMs: 12.9,
    userAgent: 'x'.repeat(1000),
    meta: { sha256: 'abc' },
  });
  assert.deepEqual(Object.keys(row).sort(), [...COLUMNS].sort());
  assert.equal(row.actor_roles, 'engineer,lead');
  assert.equal(row.status, 200);
  assert.equal(row.duration_ms, 12);
  assert.ok(row.user_agent.length < 400, 'длинные строки обрезаются');
  assert.equal(row.meta, '{"sha256":"abc"}');
  assert.ok(row.id && row.ts, 'id и метка времени проставляются сами');
});

test('неизвестная категория/исход не пишутся как есть', () => {
  const row = normalizeEntry({ action: 'x', category: 'что-то', outcome: 'может быть' });
  assert.ok(CATEGORIES.includes(row.category));
  assert.ok(OUTCOMES.includes(row.outcome));
});

test('циклический meta не роняет запись', () => {
  const cyclic = { a: 1 };
  cyclic.self = cyclic;
  assert.equal(normalizeEntry({ action: 'x', meta: cyclic }).meta, null);
});

// --- middleware --------------------------------------------------------------

function fakeReqRes({ path = '/api/tenders/t1/export/docx', method = 'GET', status = 200, principal = null } = {}) {
  const listeners = {};
  const req = {
    path,
    method,
    headers: {},
    requestId: 'req-1',
    startedAt: Date.now() - 5,
    principal,
    tenantId: principal ? principal.tenantId : null,
    security: null,
  };
  const res = {
    statusCode: status,
    on(event, fn) {
      listeners[event] = fn;
    },
    finish() {
      if (listeners.finish) listeners.finish();
    },
  };
  return { req, res };
}

const collector = () => {
  const entries = [];
  return { entries, record: (e) => entries.push(e) };
};

const config = (overrides = {}) => buildConfig({ NODE_ENV: 'test', ...overrides });

test('действие пишется в журнал с действием и категорией из правила маршрута', () => {
  const audit = collector();
  const { req, res } = fakeReqRes({ principal: { subject: 'u1', tenantId: 'tenant-a', roles: ['engineer'], email: null, authMethod: 'token' } });
  auditLogger({ audit, config: config() })(req, res, () => {});
  res.finish();

  assert.equal(audit.entries.length, 1);
  assert.equal(audit.entries[0].action, 'export.docx');
  assert.equal(audit.entries[0].category, 'export');
  assert.equal(audit.entries[0].outcome, 'allowed');
  assert.equal(audit.entries[0].tenderId, 't1');
  assert.ok(audit.entries[0].durationMs >= 0);
});

test('AUDIT_LOG_READS=0 глушит успешные чтения, но не отказы', () => {
  const audit = collector();
  const cfg = config({ AUDIT_LOG_READS: '0' });
  const principal = { subject: 'u1', tenantId: 'tenant-a', roles: ['viewer'], email: null, authMethod: 'token' };

  const ok = fakeReqRes({ path: '/api/tenders/t1', status: 200, principal });
  auditLogger({ audit, config: cfg })(ok.req, ok.res, () => {});
  ok.res.finish();
  assert.equal(audit.entries.length, 0, 'успешное чтение не пишется');

  const denied = fakeReqRes({ path: '/api/tenders/t1', status: 403, principal });
  auditLogger({ audit, config: cfg })(denied.req, denied.res, () => {});
  denied.res.finish();
  assert.equal(audit.entries.length, 1, 'отказ пишется всегда');
});

test('AUDIT_ENABLED=0 отключает журнал целиком', () => {
  const audit = collector();
  const { req, res } = fakeReqRes({ status: 500 });
  auditLogger({ audit, config: config({ AUDIT_ENABLED: '0' }) })(req, res, () => {});
  res.finish();
  assert.equal(audit.entries.length, 0);
});

test('публичный /health в журнал не попадает', () => {
  const audit = collector();
  const { req, res } = fakeReqRes({ path: '/api/health' });
  auditLogger({ audit, config: config() })(req, res, () => {});
  res.finish();
  assert.equal(audit.entries.length, 0);
});

test('сбой записи журнала не роняет запрос', () => {
  const audit = {
    record() {
      throw new Error('журнал недоступен');
    },
  };
  const realError = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a);
  try {
    const { req, res } = fakeReqRes();
    let nextCalled = false;
    auditLogger({ audit, config: config() })(req, res, () => {
      nextCalled = true;
    });
    assert.doesNotThrow(() => res.finish());
    assert.equal(nextCalled, true);
    assert.equal(logged.length, 1, 'сбой журнала обязан быть виден в логе');
  } finally {
    console.error = realError;
  }
});

test('одно событие на запрос, даже если сработали и finish, и close', () => {
  const audit = collector();
  const listeners = {};
  const req = { path: '/api/tenders', method: 'GET', headers: {}, requestId: 'r', principal: null, startedAt: Date.now() };
  const res = { statusCode: 401, on: (e, fn) => (listeners[e] = fn) };
  auditLogger({ audit, config: config() })(req, res, () => {});
  listeners.finish();
  listeners.close();
  assert.equal(audit.entries.length, 1);
});
