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
// devBypass=true собирает приложение с включённым обходом аутентификации
// (в тестовом процессе это разрешено, в production — ошибка старта).
async function withServer(t, fn, { devBypass = false } = {}) {
  const { createApp } = require('../../app');
  const { buildConfig } = require('../../security/config');
  const app = createApp({
    logger: false,
    security: devBypass ? { config: buildConfig({ NODE_ENV: 'test', AUTH_DEV_BYPASS: '1' }) } : {},
  });
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

test('любой /api-маршрут, кроме /health, закрыт аутентификацией', async (t) => {
  await withServer(t, async (base) => {
    // Неизвестный путь тоже закрыт: сначала «кто ты», и только потом разбор
    // маршрута — иначе по кодам ответа можно изучать поверхность API.
    for (const path of ['/api/definitely-not-a-route', '/api/tenders', '/api/audit']) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 401, `${path} должен требовать аутентификацию`);
      const body = await res.json();
      assert.equal(body.error, 'Требуется аутентификация');
      assert.ok(res.headers.get('www-authenticate'), 'нужен заголовок WWW-Authenticate');
    }
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
  // подвесить запрос и не уронить процесс. Аутентификацию проходим dev-обходом
  // (он разрешён только вне production).
  await withServer(
    t,
    async (base) => {
      const res = await fetch(`${base}/api/tenders`);
      assert.equal(res.status, 500);
      const body = await res.json();
      assert.match(body.error, /TEST_DATABASE_URL/);
      assert.ok(!JSON.stringify(body).includes('prod:pw@'), 'в ответе не должно быть строки подключения');
    },
    { devBypass: true },
  );
});

test('зарегистрированы все публичные /api-маршруты (набор не изменился)', () => {
  const { createApp } = require('../../app');
  const app = createApp({ logger: false });
  const stack = app._router.stack; // express 4: таблица маршрутов
  const mounted = stack.filter((l) => l.name === 'router').length;
  assert.equal(mounted, 23, 'ожидается 23 смонтированных /api-роутера (+auth, +audit)');

  const paths = [];
  for (const layer of stack) {
    if (layer.route) paths.push(layer.route.path);
  }
  assert.ok(paths.includes('/api/health'));
});
