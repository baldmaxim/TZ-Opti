'use strict';

// Единственный entrypoint сервера: читает .env, применяет миграцию, при пустой
// БД сеет демо-данные, чинит «зомби»-статусы прогонов и слушает порт.
// Сборка приложения (маршруты, middleware) — в app.js и никаких side-effect'ов
// при импорте не имеет: `require('./app')` порт не открывает и БД не трогает.
//
// Запуск: `node server.js` (npm start) или `nodemon server.js` (npm run dev).

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { createApp } = require('./app');
const { runMigration } = require('./db/migrate');
const { runSeedIfEmpty } = require('./db/seed');
const stageEngine = require('./services/stageAnalysis/stageAnalysisEngine');

const PORT = Number(process.env.PORT) || 4000;

async function start({ port = PORT, migrate = true, seed = true } = {}) {
  if (migrate) await runMigration();
  if (seed) await runSeedIfEmpty();
  // Сброс «зомби»-статусов 'running' от прогонов, погибших при прошлом
  // рестарте/падении сервера (иначе клиент вечно крутит кольцо прогресса).
  await stageEngine.recoverOrphanedRunningStages();

  const app = createApp();
  const server = app.listen(port, () => {
    console.log(`[tz-opti-server] listening on http://localhost:${server.address().port}`);
  });
  // Стадия 1 — синхронный POST на ~6-7 мин (worst ~12: бридж 600с +
  // запас openai-клиента). Node по умолчанию рвёт запрос на 5-й мин
  // (requestTimeout=300000) → в браузере «Failed to fetch». Поднимаем
  // выше всей цепочки. headersTimeout > keepAliveTimeout (рекомендация
  // Node), server.timeout=0 — без сокет-таймаута простоя (данные не
  // текут до самого ответа).
  // Цепочка таймаутов (каждый внешний > внутреннего):
  // бридж 900000 < openai-клиент 1020000 < сервер 1140000 < Vite-прокси.
  server.requestTimeout = 1140000;
  server.keepAliveTimeout = 1145000;
  server.headersTimeout = 1150000;
  server.timeout = 0;
  return server;
}

if (require.main === module) {
  start().catch((err) => {
    console.error('[tz-opti-server] startup failed:', err);
    process.exit(1);
  });
}

module.exports = { start };
