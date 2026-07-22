'use strict';

// Инвариант «тестовый процесс не ходит в production-БД» — на уровне чистого
// резолвера цели подключения. Без БД и сети. Запуск: npm run test:unit.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveConnectionString,
  hasResolvableTarget,
  sslOptionFor,
  DbTargetError,
} = require('../../db/connectionTarget');
const { isTestProcess } = require('../../utils/runtimeMode');

const PROD = 'postgresql://prod:pw@prod.example.com:5432/postgres';
const TEST = 'postgresql://test:pw@localhost:5432/tz_opti_test';

test('обычный процесс: берётся DATABASE_URL', () => {
  const env = { DATABASE_URL: PROD };
  assert.equal(resolveConnectionString(env), PROD);
});

test('обычный процесс без DATABASE_URL: fail-closed', () => {
  assert.throws(() => resolveConnectionString({}), (err) => {
    assert.ok(err instanceof DbTargetError);
    assert.equal(err.code, 'DATABASE_URL_MISSING');
    return true;
  });
});

test('тестовый процесс: production DATABASE_URL игнорируется, нужен TEST_DATABASE_URL', () => {
  const env = { NODE_ENV: 'test', DATABASE_URL: PROD, TEST_DATABASE_URL: TEST };
  assert.equal(resolveConnectionString(env), TEST);
});

test('тестовый процесс без TEST_DATABASE_URL: НЕ падает на production, а бросает', () => {
  const env = { NODE_ENV: 'test', DATABASE_URL: PROD };
  assert.throws(() => resolveConnectionString(env), (err) => {
    assert.equal(err.code, 'TEST_DATABASE_URL_MISSING');
    // Строка подключения (в ней пароль) не попадает в текст ошибки.
    assert.ok(!err.message.includes('prod.example.com'));
    return true;
  });
});

test('тестовый процесс: TEST_DATABASE_URL == DATABASE_URL запрещено', () => {
  const env = { NODE_ENV: 'test', DATABASE_URL: PROD, TEST_DATABASE_URL: ` ${PROD} ` };
  assert.throws(() => resolveConnectionString(env), (err) => {
    assert.equal(err.code, 'TEST_DATABASE_URL_EQUALS_PRODUCTION');
    return true;
  });
});

test('NODE_TEST_CONTEXT (node --test) сам по себе включает тестовый режим', () => {
  // Даже если NODE_ENV подменён снаружи на production.
  const env = { NODE_ENV: 'production', NODE_TEST_CONTEXT: 'child-v8', DATABASE_URL: PROD };
  assert.equal(isTestProcess(env), true);
  assert.throws(() => resolveConnectionString(env), (err) => err.code === 'TEST_DATABASE_URL_MISSING');
});

test('hasResolvableTarget отражает реальную доступность цели', () => {
  assert.equal(hasResolvableTarget({ DATABASE_URL: PROD }), true);
  assert.equal(hasResolvableTarget({ NODE_ENV: 'test' }), false);
});

test('этот процесс распознан как тестовый (иначе защиты выключены)', () => {
  assert.equal(isTestProcess(), true);
});

test('TLS включён по умолчанию и выключается только явным sslmode=disable', () => {
  assert.deepEqual(sslOptionFor(PROD), { rejectUnauthorized: false });
  assert.deepEqual(sslOptionFor('postgresql://u:p@db.supabase.co:5432/postgres?sslmode=require'), {
    rejectUnauthorized: false,
  });
  assert.equal(sslOptionFor('postgresql://postgres@127.0.0.1:55432/tz_opti_test?sslmode=disable'), false);
  assert.equal(sslOptionFor('postgresql://postgres@127.0.0.1:55432/db?a=1&sslmode=disable&b=2'), false);
});
