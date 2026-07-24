'use strict';

// Юнит-тесты error middleware: статус берётся из ошибки, тело — всегда JSON,
// 5xx логируются, детали/стек наружу не утекают.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const errorHandler = require('../../middleware/errorHandler');
const { badRequest, notFound, HttpError } = require('../../utils/errors');

function fakeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

// Глушим console.error на время теста (5xx логируется намеренно).
function muteConsole(t) {
  const real = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args);
  t.after(() => {
    console.error = real;
  });
  return lines;
}

test('HttpError 400 → статус и сообщение из ошибки', () => {
  const res = fakeRes();
  errorHandler(badRequest('Не загружен ТЗ'), {}, res, () => {});
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'Не загружен ТЗ');
});

test('notFound → 404', () => {
  const res = fakeRes();
  errorHandler(notFound('Тендер не найден'), {}, res, () => {});
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, 'Тендер не найден');
});

test('обычная ошибка без статуса → 500 и запись в лог', (t) => {
  const lines = muteConsole(t);
  const res = fakeRes();
  errorHandler(new Error('boom'), {}, res, () => {});
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, 'boom');
  assert.equal(lines.length, 1, '5xx должен попасть в лог');
});

test('4xx не логируется', (t) => {
  const lines = muteConsole(t);
  const res = fakeRes();
  errorHandler(badRequest('bad'), {}, res, () => {});
  assert.equal(lines.length, 0);
});

test('в production наружу уходит только generic-сообщение и request_id', (t) => {
  muteConsole(t);
  const { resetSecurityConfig } = require('../../security/config');
  const saved = process.env.ERRORS_EXPOSE_INTERNALS;
  process.env.ERRORS_EXPOSE_INTERNALS = '0';
  resetSecurityConfig();
  t.after(() => {
    if (saved === undefined) delete process.env.ERRORS_EXPOSE_INTERNALS;
    else process.env.ERRORS_EXPOSE_INTERNALS = saved;
    resetSecurityConfig();
  });

  const res = fakeRes();
  errorHandler(new Error('boom: /srv/app/server/db/connection.js:42'), { requestId: 'req-9' }, res, () => {});
  assert.deepEqual(Object.keys(res.body).sort(), ['error', 'request_id']);
  assert.equal(res.body.error, errorHandler.GENERIC_500);
  assert.equal(res.body.request_id, 'req-9');
  assert.ok(!JSON.stringify(res.body).includes('connection.js'));
});

test('вне production разработчик видит сообщение и укороченный стек', (t) => {
  muteConsole(t);
  const res = fakeRes();
  errorHandler(new Error('boom'), {}, res, () => {});
  assert.equal(res.body.error, 'boom');
  assert.ok(Array.isArray(res.body.stack) && res.body.stack.length <= 5);
});

test('code и details пробрасываются, если заданы явно', () => {
  const res = fakeRes();
  const err = new HttpError(409, 'Конфликт', { stage: 2 });
  err.code = 'STAGE_LOCKED';
  errorHandler(err, {}, res, () => {});
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'STAGE_LOCKED');
  assert.deepEqual(res.body.details, { stage: 2 });
});
