'use strict';

// Воркер очереди: берёт задачу (FOR UPDATE SKIP LOCKED), держит аренду
// (heartbeat), выполняет обработчик, коммитит результат/повтор/отмену.
//
// Один цикл = одна задача. Воркеров можно запускать сколько угодно и где угодно
// (отдельный процесс `node server/worker.js`, несколько машин) — координация
// целиком в БД:
//   • claim   — атомарный UPDATE ... FOR UPDATE SKIP LOCKED: одну строку получит
//               ровно один воркер, остальные пройдут мимо, не ожидая блокировки;
//   • lease   — heartbeat продлевает аренду; умер процесс — аренда истекла, и
//               reaper вернёт задачу в очередь (продолжит с чекпойнта) или
//               пометит interrupted;
//   • advisory-lock — гарантия «одна стадия одной ревизии считается один раз»
//               даже между процессами, которые друг о друге не знают.
//
// Всё внешнее (store / handlers / advisory / часы) инъектируется — цикл
// тестируется офлайн на фейковом сторе (server/test/unit/jobsWorker.test.js).

const jobQueue = require('./jobQueue');
const advisoryLock = require('./advisoryLock');
const M = require('./jobModel');

const DEFAULTS = Object.freeze({
  leaseMs: 60_000,      // аренда задачи; истекла — воркер считается мёртвым
  heartbeatMs: 15_000,  // продление аренды + проверка отмены
  pollIntervalMs: 2_000,// пауза, когда очередь пуста
  busyDelayMs: 5_000,   // область занята advisory-lock'ом — вернуться позже
  reapIntervalMs: 30_000,
  concurrency: 1,       // стадии — тяжёлые LLM-прогоны, параллель им вредит
});

let seq = 0;
function defaultWorkerId() {
  seq += 1;
  return `w_${process.pid}_${Date.now().toString(36)}_${seq}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createWorker(opts = {}) {
  // Реестр обработчиков подключается лениво: воркер сам по себе не тянет
  // движок стадий (важно для офлайн-тестов цикла на фейковом сторе).
  const registry = opts.handlers ? null : require('./handlers'); // eslint-disable-line global-require
  const {
    store = jobQueue,
    handlers = registry.taskHandlers,
    jobFinalizers = (registry && registry.jobFinalizers) || {},
    advisory = advisoryLock,
    workerId = defaultWorkerId(),
    taskTypes = null,
    logger = console,
  } = opts;
  const cfg = { ...DEFAULTS, ...pickNumbers(opts) };

  let running = false;
  let stopping = false;
  const loops = [];
  let reapTimer = null;
  const stats = { claimed: 0, completed: 0, failed: 0, retried: 0, cancelled: 0, busy: 0, lost: 0, reaped: 0 };

  const log = (msg) => logger && logger.log && logger.log(`[worker ${workerId}] ${msg}`);
  const warn = (msg) => logger && logger.warn && logger.warn(`[worker ${workerId}] ${msg}`);

  // --- обработка одной задачи ---------------------------------------------------

  async function processTask(task) {
    const job = await store.getJob(task.job_id);
    if (!job) {
      await store.failTask({ taskId: task.id, workerId, error: new Error('задание исчезло') });
      return { status: 'failed', task };
    }

    // Область занята другим процессом → не расходуем попытку, вернём в очередь.
    const lock = await advisory.acquire(job.lock_key, { label: `${job.tender_id}/${job.scope_key}` });
    if (!lock) {
      await store.releaseTask({
        taskId: task.id, workerId, delayMs: cfg.busyDelayMs,
        reason: `область ${job.scope_key} занята другим прогоном — ожидание`,
      });
      stats.busy += 1;
      return { status: 'busy', task, job };
    }

    const state = {
      lost: false,          // аренду увели: коммитить результат нельзя
      cancelled: false,     // инженер запросил отмену
      settled: false,       // задача завершена — heartbeat больше не нужен
      total: Number(task.progress_total) || 0,
      done: Number(task.progress_done) || 0,
      checkpoint: safeParse(task.checkpoint_json),
    };

    const beat = async ({ progressDone = null, progressTotal = null, checkpoint = undefined } = {}) => {
      const res = await store.heartbeat({
        taskId: task.id, workerId, leaseMs: cfg.leaseMs, progressDone, progressTotal, checkpoint,
      });
      if (!res.ok) state.lost = true;
      if (res.cancelRequested) state.cancelled = true;
      return res;
    };

    let beatTimer = null;
    const scheduleBeat = () => {
      beatTimer = setTimeout(async () => {
        if (state.settled) return;
        try { await beat(); } catch (e) { warn(`heartbeat: ${e.message}`); }
        if (!stopping && !state.lost && !state.settled) scheduleBeat();
      }, cfg.heartbeatMs);
      if (beatTimer.unref) beatTimer.unref();
    };
    scheduleBeat();

    const guard = () => {
      if (state.cancelled) throw new M.JobCancelledError(`Задание отменено (${job.scope_key})`);
      if (state.lost) {
        const err = new Error('Аренда задачи потеряна — работу продолжает другой воркер');
        err.leaseLost = true;
        err.retryable = false;
        throw err;
      }
    };

    const ctx = {
      job,
      task,
      workerId,
      store, // обработчику иногда нужны соседние задачи задания (шаги конвейера)
      payload: { ...safeParse(job.payload_json), ...safeParse(task.payload_json) },
      checkpoint: state.checkpoint,
      guard,
      isCancelled: () => state.cancelled,
      // Прогресс пишем сразу: шаг стадии — минуты, лишний UPDATE ничего не стоит,
      // зато кольцо прогресса в портале не врёт и переживает рестарт.
      // setTotal открывает счёт заново: повтор задачи считает сегменты с нуля
      // (часть из них возьмётся из чекпойнта — прогресс просто быстро добежит).
      async setTotal(total) {
        state.total = Number(total) || 0;
        state.done = 0;
        await beat({ progressTotal: state.total, progressDone: 0 });
      },
      async tick(by = 1) {
        state.done += by;
        await beat({ progressDone: state.done, progressTotal: state.total });
      },
      async setProgress(done, total) {
        state.done = Number(done) || 0;
        if (total != null) state.total = Number(total) || 0;
        await beat({ progressDone: state.done, progressTotal: state.total });
      },
      async saveCheckpoint(data) {
        state.checkpoint = data;
        await beat({ checkpoint: data, progressDone: state.done, progressTotal: state.total });
      },
      log: (msg) => log(`${task.task_key}: ${msg}`),
    };

    const handler = handlers[task.task_type];
    let outcome;
    try {
      if (!handler) throw nonRetryable(new Error(`нет обработчика задачи «${task.task_type}»`));
      // Отмену/увод аренды могли запросить, пока задача ждала очереди.
      const first = await beat();
      if (!first.ok) throw Object.assign(new Error('аренда потеряна'), { leaseLost: true, retryable: false });
      if (first.cancelRequested) throw new M.JobCancelledError();

      const result = await (typeof handler === 'function' ? handler(ctx) : handler.run(ctx));
      // Работа доведена до конца — фиксируем её, даже если отмену успели
      // запросить в самом конце: результат уже в БД, «отменить» его нечем.
      // Аренду мог увести другой воркер — тогда completeTask вернёт null и
      // мы просто уходим, не переписывая чужую попытку.
      const done = await store.completeTask({ taskId: task.id, workerId, result: result ?? null });
      if (!done) {
        stats.lost += 1;
        outcome = { status: 'lost', task, job };
      } else {
        stats.completed += 1;
        outcome = { status: 'completed', task: done, job, result };
      }
    } catch (err) {
      outcome = await settleFailure({ task, job, err, state });
    } finally {
      state.settled = true;
      if (beatTimer) clearTimeout(beatTimer);
      await lock.release();
    }

    // Свести статус задания и отдать управление финализатору типа задания
    // (например: вернуть стадию из 'running' в 'open' после сбоя/отмены).
    const finalized = await store.finalizeJob(job.id);
    await runJobFinalizer(finalized, outcome);
    return { ...outcome, job: finalized || job };
  }

  async function settleFailure({ task, job, err, state }) {
    if (err && (err.cancelled || state.cancelled)) {
      const t = await store.cancelTask({ taskId: task.id, workerId, reason: err.message || 'отменено' });
      stats.cancelled += 1;
      return { status: 'cancelled', task: t || task, job, error: err };
    }
    if (err && err.leaseLost) {
      // Задачу уже ведёт другой воркер — молча уходим, ничего не трогая.
      stats.lost += 1;
      return { status: 'lost', task, job, error: err };
    }
    const decision = M.retryDecision({ attempts: task.attempts, maxAttempts: task.max_attempts, error: err });
    if (decision.action === 'retry') {
      await store.failTask({ taskId: task.id, workerId, error: err, retryDelayMs: decision.delayMs });
      stats.retried += 1;
      warn(`${task.task_key}: ${err.message} → повтор через ${Math.round(decision.delayMs / 1000)}с ` +
        `(попытка ${task.attempts}/${task.max_attempts})`);
      return { status: 'retry', task, job, error: err, delayMs: decision.delayMs };
    }
    await store.failTask({ taskId: task.id, workerId, error: err });
    stats.failed += 1;
    warn(`${task.task_key}: ${err.message} → провал (${decision.reason})`);
    return { status: 'failed', task, job, error: err };
  }

  async function runJobFinalizer(job, outcome) {
    if (!job || !M.isTerminalJobStatus(job.status)) return;
    const fin = jobFinalizers[job.job_type];
    if (!fin) return;
    try {
      await fin({ job, tasks: job._tasks || (await store.getTasks(job.id)), outcome });
    } catch (e) {
      warn(`финализатор задания ${job.job_type}: ${e.message}`);
    }
  }

  // --- цикл ----------------------------------------------------------------------

  // Один шаг: взять задачу и выполнить. null — очередь пуста.
  async function runOnce() {
    const task = await store.claimTask({ workerId, leaseMs: cfg.leaseMs, taskTypes });
    if (!task) return null;
    stats.claimed += 1;
    return processTask(task);
  }

  async function loop() {
    while (running) {
      let res = null;
      try {
        res = await runOnce();
      } catch (e) {
        warn(`цикл: ${e.message}`);
        await sleep(cfg.pollIntervalMs);
        continue;
      }
      if (!res) await sleep(cfg.pollIntervalMs); // eslint-disable-line no-await-in-loop
    }
  }

  async function reap() {
    try {
      const r = await store.reapExpiredTasks({});
      stats.reaped += r.requeued + r.interrupted;
      if (r.requeued || r.interrupted) {
        log(`восстановление очереди: возвращено в очередь ${r.requeued}, помечено interrupted ${r.interrupted}`);
        for (const jobId of r.jobs) {
          // eslint-disable-next-line no-await-in-loop
          const job = await store.getJob(jobId);
          // eslint-disable-next-line no-await-in-loop
          if (job) await runJobFinalizer({ ...job, _tasks: await store.getTasks(jobId) }, { status: 'interrupted' });
        }
      }
      return r;
    } catch (e) {
      warn(`reaper: ${e.message}`);
      return { requeued: 0, interrupted: 0, jobs: [] };
    }
  }

  async function start() {
    if (running) return;
    running = true;
    stopping = false;
    await reap(); // подобрать задачи, осиротевшие при прошлом падении/рестарте
    reapTimer = setInterval(reap, cfg.reapIntervalMs);
    if (reapTimer.unref) reapTimer.unref();
    for (let i = 0; i < cfg.concurrency; i += 1) loops.push(loop());
    log(`старт: concurrency=${cfg.concurrency}, lease=${cfg.leaseMs}мс, poll=${cfg.pollIntervalMs}мс`);
  }

  // Мягкая остановка: дождаться текущих задач и вернуть недоделанное в очередь
  // (после рестарта оно продолжится сразу, не дожидаясь истечения аренды).
  async function stop({ release = true } = {}) {
    stopping = true;
    running = false;
    if (reapTimer) clearInterval(reapTimer);
    if (loops.length) await Promise.allSettled(loops);
    loops.length = 0;
    if (release) {
      try {
        const n = await store.releaseWorkerTasks(workerId);
        if (n) log(`возвращено в очередь при остановке: ${n}`);
      } catch (e) {
        warn(`остановка: ${e.message}`);
      }
    }
    log('остановлен');
  }

  return { id: workerId, cfg, stats, start, stop, runOnce, reap, processTask };
}

function pickNumbers(opts) {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) {
    if (opts[k] != null) out[k] = Number(opts[k]);
  }
  return out;
}

function safeParse(v) {
  if (v == null || v === '') return null;
  try { return JSON.parse(v); } catch (_e) { return null; }
}

function nonRetryable(err) {
  err.retryable = false;
  return err;
}

// Конфигурация воркера из окружения (общая для встроенного и отдельного процесса).
function workerOptionsFromEnv(env = process.env) {
  const num = (v, d) => (v == null || v === '' ? d : Number(v));
  return {
    concurrency: num(env.WORKER_CONCURRENCY, DEFAULTS.concurrency),
    leaseMs: num(env.WORKER_LEASE_MS, DEFAULTS.leaseMs),
    heartbeatMs: num(env.WORKER_HEARTBEAT_MS, DEFAULTS.heartbeatMs),
    pollIntervalMs: num(env.WORKER_POLL_MS, DEFAULTS.pollIntervalMs),
    reapIntervalMs: num(env.WORKER_REAP_MS, DEFAULTS.reapIntervalMs),
  };
}

module.exports = { createWorker, workerOptionsFromEnv, DEFAULTS };
