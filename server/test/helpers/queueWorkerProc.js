'use strict';

// Отдельный ПРОЦЕСС-воркер для integration-теста «два воркера».
// Запускается через child_process.fork из теста; окружение (TEST_DATABASE_URL,
// NODE_ENV=test) наследуется от родителя, поэтому подключение идёт в тестовую БД.
//
// Разбирает только задачи типа 'test_exec' и на каждое ВЫПОЛНЕНИЕ пишет строку в
// служебную таблицу _jobs_test_log — по ней родитель проверяет, что ни одна
// задача не была выполнена дважды.

const { createWorker } = require('../../services/jobs/worker');
const db = require('../../db/connection');

const handlers = {
  test_exec: async (ctx) => {
    const payload = ctx.payload || {};
    if (payload.sleepMs) await new Promise((r) => setTimeout(r, payload.sleepMs));
    await db.queryRun(
      'INSERT INTO _jobs_test_log (id, task_id, worker_id, worker_pid, at) VALUES (?, ?, ?, ?, ?)',
      `${ctx.task.id}:${process.pid}:${ctx.task.attempts}`,
      ctx.task.id,
      ctx.workerId,
      String(process.pid),
      new Date().toISOString(),
    );
    return { pid: process.pid, worker: ctx.workerId };
  },
};

const worker = createWorker({
  handlers,
  taskTypes: ['test_exec'],
  pollIntervalMs: 50,
  leaseMs: 15_000,
  heartbeatMs: 5_000,
  reapIntervalMs: 60_000,
  logger: { log: () => {}, warn: () => {} },
});

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try {
    await worker.stop();
    await db.close();
  } finally {
    process.exit(0);
  }
}

process.on('message', (msg) => {
  if (msg === 'stop') stop();
  // 'kill' — эмуляция аварийной гибели процесса: ни stop(), ни возврата задач.
  if (msg === 'kill') process.exit(1);
});

worker.start()
  .then(() => process.send && process.send({ ready: true, id: worker.id, pid: process.pid }))
  .catch((e) => {
    if (process.send) process.send({ error: e.message });
    process.exit(1);
  });
