'use strict';

// Entrypoint ОТДЕЛЬНОГО процесса-воркера: `npm --prefix server run worker`.
// Порт не слушает, HTTP не обслуживает — только разбирает очередь
// analysis_jobs/analysis_tasks. Воркеров можно поднять несколько (на одной или
// разных машинах): координация целиком в Postgres (SKIP LOCKED + аренда +
// advisory-lock), общего состояния в памяти нет.
//
// API-процесс по умолчанию поднимает воркер внутри себя (как было раньше:
// «запустил сервер — анализ работает»). Чтобы развести их по процессам:
//   WORKER_MODE=external npm --prefix server start   # только API
//   npm --prefix server run worker                   # один или несколько воркеров

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { createWorker, workerOptionsFromEnv } = require('./services/jobs/worker');
const db = require('./db/connection');

async function start(opts = {}) {
  const worker = createWorker({ ...workerOptionsFromEnv(), ...opts });
  await worker.start();
  return worker;
}

// Аккуратная остановка: вернуть незаконченные задачи в очередь, чтобы после
// перезапуска они продолжились сразу, а не по истечении аренды.
function installShutdown(worker) {
  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`[worker] ${signal}: останавливаюсь…`);
    try {
      await worker.stop();
      await db.close();
    } catch (e) {
      console.error('[worker] ошибка остановки:', e.message);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  start()
    .then((worker) => {
      installShutdown(worker);
      console.log(`[worker] ${worker.id} готов, разбираю очередь analysis_tasks`);
    })
    .catch((err) => {
      console.error('[worker] startup failed:', err);
      process.exit(1);
    });
}

module.exports = { start, installShutdown };
