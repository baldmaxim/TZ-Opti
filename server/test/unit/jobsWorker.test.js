'use strict';

// Юнит-тесты ЦИКЛА воркера очереди — офлайн, на фейковом сторе (без Postgres,
// без сети, без LLM). Проверяется поведение, ради которого очередь и заводилась:
//   • повторный запуск сбойной задачи (retry + backoff) и продолжение с чекпойнта;
//   • два воркера на одной очереди — каждая задача выполняется РОВНО ОДИН раз;
//   • advisory-lock не пускает второй прогон той же области;
//   • отмена снимает бегущую задачу кооперативно;
//   • потеря аренды: «медленный» воркер не может закоммитить результат дважды;
//   • рестарт: осиротевшие задачи возвращаются в очередь или получают interrupted.
// Что SQL реализует ровно эти правила — проверяет test/integration/jobs.integration.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createWorker } = require('../../services/jobs/worker');
const { createFakeQueue, createFakeAdvisory } = require('../helpers/fakeQueue');
const { blockNetwork } = require('../helpers/network');

// Управляемые часы: без них backoff пришлось бы «пережидать» реально.
function harness({ handlers, workers = 1, advisory = createFakeAdvisory(), lease = 60_000 } = {}) {
  let now = Date.parse('2026-07-01T10:00:00.000Z');
  const store = createFakeQueue({ nowMs: () => now });
  const silent = { log: () => {}, warn: () => {} };
  const made = [];
  for (let i = 0; i < workers; i += 1) {
    made.push(createWorker({
      store, handlers, advisory, logger: silent,
      workerId: `w${i + 1}`, leaseMs: lease, heartbeatMs: 3_600_000,
    }));
  }
  return {
    store,
    advisory,
    workers: made,
    worker: made[0],
    tick: (ms) => { now += ms; },
    now: () => now,
  };
}

// --- Успешный прогон ------------------------------------------------------------------

test('успешная задача: completed, результат сохранён, задание завершено', async (t) => {
  blockNetwork(t);
  const h = harness({ handlers: { test: async () => ({ ok: 1 }) } });
  const { job } = h.store.addJob({ tasks: [{ taskKey: 'main', taskType: 'test' }] });

  const res = await h.worker.runOnce();
  assert.equal(res.status, 'completed');
  const tasks = await h.store.getTasks(job.id);
  assert.equal(tasks[0].status, 'completed');
  assert.deepEqual(JSON.parse(tasks[0].result_json), { ok: 1 });
  assert.equal((await h.store.getJob(job.id)).status, 'completed');
  // Очередь пуста — второй прогон ничего не берёт (задача не выполняется дважды).
  assert.equal(await h.worker.runOnce(), null);
});

// --- Повторный запуск и чекпойнт ---------------------------------------------------------

test('повторный запуск: временный сбой → задача возвращается в очередь и доводится со ВТОРОЙ попытки', async (t) => {
  blockNetwork(t);
  const calls = [];
  const handlers = {
    test: async (ctx) => {
      calls.push(ctx.task.attempts);
      if (calls.length === 1) throw Object.assign(new Error('LLM 502'), { status: 502 });
      return { attempt: ctx.task.attempts };
    },
  };
  const h = harness({ handlers });
  const { job } = h.store.addJob({ tasks: [{ taskKey: 'main', taskType: 'test', maxAttempts: 3 }] });

  const first = await h.worker.runOnce();
  assert.equal(first.status, 'retry');
  let tasks = await h.store.getTasks(job.id);
  assert.equal(tasks[0].status, 'queued', 'после временного сбоя задача снова в очереди');
  assert.equal(tasks[0].attempts, 1);
  assert.equal((await h.store.getJob(job.id)).status, 'running', 'задание ещё не финализировано');

  // Отложенный старт: до истечения backoff задача не выдаётся.
  assert.equal(await h.worker.runOnce(), null, 'повтор не должен стартовать раньше времени');
  h.tick(first.delayMs + 1);

  const second = await h.worker.runOnce();
  assert.equal(second.status, 'completed');
  tasks = await h.store.getTasks(job.id);
  assert.equal(tasks[0].attempts, 2);
  assert.equal((await h.store.getJob(job.id)).status, 'completed');
  assert.deepEqual(calls, [1, 2]);
});

test('повторный запуск продолжает с ЧЕКПОЙНТА: сделанные части не пересчитываются', async (t) => {
  blockNetwork(t);
  const segments = ['a', 'b', 'c', 'd'];
  const computed = [];
  const handlers = {
    test: async (ctx) => {
      const done = { ...((ctx.checkpoint && ctx.checkpoint.parts) || {}) };
      await ctx.setTotal(segments.length);
      for (const [i, seg] of segments.entries()) {
        if (done[i] != null) { await ctx.tick(); continue; } // взято из чекпойнта
        if (computed.length === 2 && !ctx.task.checkpoint_json) {
          // Падаем ровно посередине первой попытки.
          throw Object.assign(new Error('обрыв связи'), { status: 502 });
        }
        computed.push(seg);
        done[i] = seg.toUpperCase();
        // eslint-disable-next-line no-await-in-loop
        await ctx.saveCheckpoint({ parts: done });
        // eslint-disable-next-line no-await-in-loop
        await ctx.tick();
      }
      return { parts: done };
    },
  };
  const h = harness({ handlers });
  const { job } = h.store.addJob({ tasks: [{ taskKey: 'main', taskType: 'test', maxAttempts: 3 }] });

  const first = await h.worker.runOnce();
  assert.equal(first.status, 'retry');
  const afterFail = (await h.store.getTasks(job.id))[0];
  assert.ok(afterFail.checkpoint_json, 'чекпойнт первой попытки сохранён');
  assert.deepEqual(Object.keys(JSON.parse(afterFail.checkpoint_json).parts), ['0', '1']);
  assert.deepEqual(computed, ['a', 'b']);

  h.tick(first.delayMs + 1);
  const second = await h.worker.runOnce();
  assert.equal(second.status, 'completed');
  // Вторая попытка досчитала только оставшееся — 'a' и 'b' не пересчитывались.
  assert.deepEqual(computed, ['a', 'b', 'c', 'd']);
  const done = (await h.store.getTasks(job.id))[0];
  assert.equal(done.progress_done, 4);
  assert.equal(done.progress_total, 4);
});

test('невосстановимая ошибка (4xx) не повторяется: задача сразу failed', async (t) => {
  blockNetwork(t);
  let calls = 0;
  const handlers = {
    test: async () => { calls += 1; throw Object.assign(new Error('Стадия 2 недоступна'), { status: 400 }); },
  };
  const h = harness({ handlers });
  const { job } = h.store.addJob({ tasks: [{ taskKey: 'main', taskType: 'test', maxAttempts: 3 }] });

  const res = await h.worker.runOnce();
  assert.equal(res.status, 'failed');
  assert.equal(calls, 1);
  assert.equal((await h.store.getJob(job.id)).status, 'failed');
  h.tick(60_000);
  assert.equal(await h.worker.runOnce(), null, 'повтора быть не должно');
});

test('сбой шага задания: следующие шаги — skipped, финализатор (always_run) отрабатывает', async (t) => {
  blockNetwork(t);
  const ran = [];
  const handlers = {
    step: async (ctx) => {
      ran.push(ctx.task.task_key);
      if (ctx.task.task_key === 'step:b') throw Object.assign(new Error('шаг упал'), { retryable: false });
      return { ok: true };
    },
    finalize: async (ctx) => { ran.push('finalize'); return { steps: (await ctx.store.getTasks(ctx.job.id)).length }; },
  };
  const h = harness({ handlers });
  const { job } = h.store.addJob({
    tasks: [
      { taskKey: 'step:a', taskType: 'step', seq: 0 },
      { taskKey: 'step:b', taskType: 'step', seq: 1 },
      { taskKey: 'step:c', taskType: 'step', seq: 2 },
      { taskKey: 'finalize', taskType: 'finalize', seq: 3, alwaysRun: true },
    ],
  });

  for (let i = 0; i < 5; i += 1) await h.worker.runOnce(); // eslint-disable-line no-await-in-loop
  assert.deepEqual(ran, ['step:a', 'step:b', 'finalize']);
  const byKey = Object.fromEntries((await h.store.getTasks(job.id)).map((x) => [x.task_key, x.status]));
  assert.deepEqual(byKey, {
    'step:a': 'completed', 'step:b': 'failed', 'step:c': 'skipped', finalize: 'completed',
  });
  assert.equal((await h.store.getJob(job.id)).status, 'failed', 'задание в целом — сбой');
});

// --- Два воркера ---------------------------------------------------------------------------

test('два воркера на одной очереди: каждая задача выполняется ровно один раз (без дублей)', async (t) => {
  blockNetwork(t);
  const executed = [];
  const handlers = {
    test: async (ctx) => {
      executed.push(`${ctx.task.task_key}@${ctx.workerId}`);
      return { by: ctx.workerId };
    },
  };
  const h = harness({ handlers, workers: 2 });
  // 6 независимых заданий (по задаче в каждом), разные области — advisory-lock
  // не мешает, но одну и ту же строку два воркера получить не должны.
  const ids = [];
  for (let i = 0; i < 6; i += 1) {
    ids.push(h.store.addJob({ scopeKey: `scope:${i}`, tasks: [{ taskKey: `t${i}`, taskType: 'test' }] }).job.id);
  }

  // Оба воркера «одновременно» разбирают очередь до опустошения.
  const [w1, w2] = h.workers;
  const drain = async (w) => { let r; do { r = await w.runOnce(); } while (r); }; // eslint-disable-line no-await-in-loop
  await Promise.all([drain(w1), drain(w2)]);

  assert.equal(executed.length, 6, 'выполнено ровно 6 задач — ни одной дважды');
  assert.equal(new Set(executed.map((e) => e.split('@')[0])).size, 6, 'все задачи разные');
  const byWorker = executed.map((e) => e.split('@')[1]);
  assert.ok(byWorker.includes('w1') && byWorker.includes('w2'), 'работали оба воркера');
  for (const id of ids) assert.equal((await h.store.getJob(id)).status, 'completed'); // eslint-disable-line no-await-in-loop
});

test('advisory-lock: область, занятая другим процессом, не считается вторым воркером', async (t) => {
  blockNetwork(t);
  let runs = 0;
  const advisory = createFakeAdvisory();
  const h = harness({ handlers: { test: async () => { runs += 1; return {}; } }, advisory });
  const { job } = h.store.addJob({ scopeKey: 'stage:1', tasks: [{ taskKey: 'main', taskType: 'test' }] });

  // Чужой процесс уже держит замок на (тендер + стадия + ревизия).
  const free = advisory.take(job.lock_key);
  const busy = await h.worker.runOnce();
  assert.equal(busy.status, 'busy');
  assert.equal(runs, 0, 'обработчик не должен был выполниться');
  const t1 = (await h.store.getTasks(job.id))[0];
  assert.equal(t1.status, 'queued', 'задача вернулась в очередь');
  assert.equal(t1.attempts, 0, 'попытка не израсходована — воркер не работал');

  free();
  h.tick(10_000);
  assert.equal((await h.worker.runOnce()).status, 'completed');
  assert.equal(runs, 1);
});

// --- Отмена -------------------------------------------------------------------------------

test('отмена бегущей задачи: guard() прерывает работу, задание переходит в cancelled', async (t) => {
  blockNetwork(t);
  let sawCancel = false;
  const handlers = {
    test: async (ctx) => {
      await ctx.tick();                       // heartbeat #1 — отмены ещё нет
      await ctx.store.requestCancel(ctx.job.id); // инженер нажал «Отменить»
      await ctx.tick();                       // heartbeat #2 — узнаём про отмену
      sawCancel = ctx.isCancelled();
      ctx.guard();                            // здесь и прерываемся
      return { never: true };
    },
  };
  const h = harness({ handlers });
  const { job } = h.store.addJob({ tasks: [{ taskKey: 'main', taskType: 'test' }] });

  const res = await h.worker.runOnce();
  assert.equal(sawCancel, true);
  assert.equal(res.status, 'cancelled');
  assert.equal((await h.store.getTasks(job.id))[0].status, 'cancelled');
  assert.equal((await h.store.getJob(job.id)).status, 'cancelled');
});

test('отмена задания в очереди: задачи снимаются сразу, воркеру брать нечего', async (t) => {
  blockNetwork(t);
  let runs = 0;
  const h = harness({ handlers: { test: async () => { runs += 1; return {}; } } });
  const { job } = h.store.addJob({ tasks: [{ taskKey: 'main', taskType: 'test' }] });

  await h.store.requestCancel(job.id);
  assert.equal(await h.worker.runOnce(), null);
  assert.equal(runs, 0);
  assert.equal((await h.store.getJob(job.id)).status, 'cancelled');
});

// --- Потеря аренды ---------------------------------------------------------------------------

test('потерянная аренда: «воскресший» воркер НЕ коммитит результат поверх чужой работы', async (t) => {
  blockNetwork(t);
  const h = harness({ handlers: {
    test: async (ctx) => {
      // Пока задача считалась, её аренду перехватил другой воркер.
      const row = h.store._tasks.get(ctx.task.id);
      row.locked_by = 'w-other';
      return { ok: true };
    },
  } });
  const { job } = h.store.addJob({ tasks: [{ taskKey: 'main', taskType: 'test' }] });

  const res = await h.worker.runOnce();
  assert.equal(res.status, 'lost');
  const task = (await h.store.getTasks(job.id))[0];
  assert.equal(task.status, 'running', 'задача осталась за новым владельцем');
  assert.equal(task.locked_by, 'w-other');
  assert.equal(task.result_json, null, 'результат потерявшего аренду не записан');
});

// --- Рестарт ------------------------------------------------------------------------------------

test('рестарт: осиротевшая задача с истёкшей арендой возвращается в очередь и доводится', async (t) => {
  blockNetwork(t);
  const h = harness({ handlers: { test: async () => ({ ok: true }) }, lease: 30_000 });
  const { job } = h.store.addJob({ tasks: [{ taskKey: 'main', taskType: 'test', maxAttempts: 3 }] });

  // Воркер взял задачу и «умер» (процесс убит — ни complete, ни fail).
  const claimed = await h.store.claimTask({ workerId: 'w-dead', leaseMs: 30_000 });
  assert.equal(claimed.status, 'running');
  assert.equal(await h.worker.runOnce(), null, 'пока аренда жива, задачу никто не подхватит');

  h.tick(31_000); // аренда истекла
  const reaped = await h.worker.reap();
  assert.equal(reaped.requeued, 1);
  assert.equal(reaped.interrupted, 0);

  const res = await h.worker.runOnce();
  assert.equal(res.status, 'completed', 'после рестарта работа продолжается');
  assert.equal((await h.store.getJob(job.id)).status, 'completed');
});

test('рестарт: попытки исчерпаны → задача interrupted, задание interrupted', async (t) => {
  blockNetwork(t);
  const h = harness({ handlers: { test: async () => ({ ok: true }) }, lease: 30_000 });
  const { job } = h.store.addJob({ tasks: [{ taskKey: 'main', taskType: 'test', maxAttempts: 1 }] });

  await h.store.claimTask({ workerId: 'w-dead', leaseMs: 30_000 });
  h.tick(31_000);
  const reaped = await h.worker.reap();
  assert.equal(reaped.interrupted, 1);

  const task = (await h.store.getTasks(job.id))[0];
  assert.equal(task.status, 'interrupted');
  assert.match(task.error, /прервано/);
  assert.equal((await h.store.getJob(job.id)).status, 'interrupted');
  assert.equal(await h.worker.runOnce(), null, 'оборванная задача не выдаётся снова');
});

test('мягкая остановка воркера возвращает недоделанное в очередь, не тратя попытку', async (t) => {
  blockNetwork(t);
  const h = harness({ handlers: { test: async () => ({}) } });
  const { job } = h.store.addJob({ tasks: [{ taskKey: 'main', taskType: 'test' }] });

  await h.store.claimTask({ workerId: h.worker.id, leaseMs: 60_000 });
  await h.worker.stop();

  const task = (await h.store.getTasks(job.id))[0];
  assert.equal(task.status, 'queued');
  assert.equal(task.attempts, 0);
  assert.equal((await h.store.getJob(job.id)).status, 'queued');
});

test('финализатор задания вызывается на терминальном статусе (сброс статуса стадии)', async (t) => {
  blockNetwork(t);
  const settled = [];
  const h = harness({ handlers: { test: async () => { throw Object.assign(new Error('нет ключа'), { status: 400 }); } } });
  const worker = require('../../services/jobs/worker').createWorker({
    store: h.store,
    handlers: { test: async () => { throw Object.assign(new Error('нет ключа'), { status: 400 }); } },
    jobFinalizers: { test_job: async ({ job }) => settled.push(job.status) },
    advisory: h.advisory,
    logger: { log: () => {}, warn: () => {} },
    workerId: 'wf',
    heartbeatMs: 3_600_000,
  });
  h.store.addJob({ jobType: 'test_job', tasks: [{ taskKey: 'main', taskType: 'test' }] });

  await worker.runOnce();
  assert.deepEqual(settled, ['failed']);
});
