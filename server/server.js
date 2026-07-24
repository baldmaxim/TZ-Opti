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
const { createWorker, workerOptionsFromEnv } = require('./services/jobs/worker');

const PORT = Number(process.env.PORT) || 4000;

// Воркер очереди по умолчанию поднимается ВНУТРИ API-процесса: «запустил сервер
// — анализ работает», как было до очереди. WORKER_MODE=external выключает его,
// когда воркеры вынесены в отдельные процессы (npm --prefix server run worker).
const workerEnabled = (env = process.env) =>
  String(env.WORKER_MODE || 'embedded').trim().toLowerCase() !== 'external';

async function start({ port = PORT, migrate = true, seed = true, worker = workerEnabled() } = {}) {
  if (migrate) await runMigration();
  if (seed) await runSeedIfEmpty();
  // Задачи, осиротевшие при прошлом падении/рестарте: их подберёт reaper воркера
  // (продолжит с чекпойнта либо пометит interrupted). Здесь — только «зомби»
  // статусы стадий, за которыми не стоит ни одного живого задания.
  await stageEngine.recoverOrphanedRunningStages();

  let queueWorker = null;
  if (worker) {
    queueWorker = createWorker(workerOptionsFromEnv());
    await queueWorker.start();
  } else {
    console.log('[tz-opti-server] WORKER_MODE=external — очередь разбирают отдельные процессы');
  }

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
  server.queueWorker = queueWorker;
  return server;
}

if (require.main === module) {
  start()
    .then((server) => {
      // Остановка процесса возвращает недоделанные задачи в очередь — после
      // перезапуска они продолжатся сразу, не дожидаясь истечения аренды.
      const shutdown = async (signal) => {
        console.log(`[tz-opti-server] ${signal}: останавливаюсь…`);
        if (server.queueWorker) await server.queueWorker.stop().catch(() => {});
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 5000).unref();
      };
      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGTERM', () => shutdown('SIGTERM'));
    })
    .catch((err) => {
      console.error('[tz-opti-server] startup failed:', err);
      process.exit(1);
    });
}

module.exports = { start, workerEnabled };
