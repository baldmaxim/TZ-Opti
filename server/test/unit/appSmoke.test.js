'use strict';

// Smoke createApp(): приложение собирается без открытия порта, без миграции и
// без сида; публичные маршруты на месте; 404-обработчик и error middleware
// отвечают JSON. HTTP-проверки — на localhost:0 (эфемерный порт, офлайн).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// --- 1. Импорт и сборка не открывают порт ------------------------------------

test('require(app) + createApp() не вызывают listen', (t) => {
  const realListen = http.Server.prototype.listen;
  const listens = [];
  http.Server.prototype.listen = function spyListen(...args) {
    listens.push(args);
    return realListen.apply(this, args);
  };
  t.after(() => {
    http.Server.prototype.listen = realListen;
  });

  const { createApp } = require('../../app');
  const app = createApp({ logger: false });

  assert.equal(typeof app, 'function', 'createApp должен вернуть express-приложение');
  assert.deepEqual(listens, [], 'сборка приложения не должна открывать порт');
});

test('createApp возвращает независимые экземпляры', () => {
  const { createApp } = require('../../app');
  assert.notEqual(createApp({ logger: false }), createApp({ logger: false }));
});

// --- 2. HTTP-поведение --------------------------------------------------------

// Поднимает приложение на эфемерном порту 127.0.0.1 и гарантированно гасит.
async function withServer(t, fn) {
  const { createApp } = require('../../app');
  const app = createApp({ logger: false });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return fn(base);
}

test('GET /api/health → 200 {ok:true} (без БД)', async (t) => {
  await withServer(t, async (base) => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.ts, 'string');
  });
});

test('неизвестный /api-маршрут → 404 JSON, публичные маршруты не тронуты', async (t) => {
  await withServer(t, async (base) => {
    const res = await fetch(`${base}/api/definitely-not-a-route`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, 'Not found');
    assert.equal(body.path, '/api/definitely-not-a-route');
  });
});

test('ошибка в маршруте уходит в error middleware: 500 JSON, без утечки строки подключения', async (t) => {
  const savedDb = process.env.DATABASE_URL;
  const savedTestDb = process.env.TEST_DATABASE_URL;
  process.env.DATABASE_URL = 'postgresql://prod:pw@prod.example.com:5432/postgres';
  delete process.env.TEST_DATABASE_URL;
  t.after(() => {
    if (savedDb === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDb;
    if (savedTestDb !== undefined) process.env.TEST_DATABASE_URL = savedTestDb;
  });

  // errorHandler логирует 5xx — это ожидаемо, глушим шум в выводе тестов.
  const realError = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = realError;
  });

  // /api/tenders обращается к БД; в тестовом процессе без TEST_DATABASE_URL это
  // fail-closed ошибка — она обязана дойти до errorHandler как JSON, а не
  // подвесить запрос и не уронить процесс.
  await withServer(t, async (base) => {
    const res = await fetch(`${base}/api/tenders`);
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.match(body.error, /TEST_DATABASE_URL/);
    assert.ok(!JSON.stringify(body).includes('prod:pw@'), 'в ответе не должно быть строки подключения');
  });
});

test('зарегистрированы все публичные /api-маршруты (набор не изменился)', () => {
  const { createApp } = require('../../app');
  const app = createApp({ logger: false });
  const stack = app._router.stack; // express 4: таблица маршрутов
  const mounted = stack.filter((l) => l.name === 'router').length;
  assert.equal(mounted, 21, 'ожидается 21 смонтированный /api-роутер');

  const paths = [];
  for (const layer of stack) {
    if (layer.route) paths.push(layer.route.path);
  }
  assert.ok(paths.includes('/api/health'));
});
