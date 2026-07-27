'use strict';

// Integration: устойчивая очередь на ЖИВОЙ PostgreSQL (TEST_DATABASE_URL).
// Здесь проверяется то, что офлайн-тест проверить не может, — что именно SQL
// даёт нужные гарантии:
//   • повторный запуск не создаёт дубль задания (частичный UNIQUE-индекс),
//     в том числе при ОДНОВРЕМЕННЫХ запросах;
//   • FOR UPDATE SKIP LOCKED: два воркера разбирают очередь параллельно и ни
//     одна задача не выполняется дважды — в т.ч. в ДВУХ ПРОЦЕССАХ;
//   • pg_try_advisory_lock: одна стадия одной ревизии не считается дважды;
//   • рестарт/падение: аренда истекает → задача возвращается в очередь (с
//     чекпойнтом) либо получает статус interrupted;
//   • прогресс, чекпойнт и отмена живут в БД и переживают смену процесса.
//
//   npm run test:integration     — без TEST_DATABASE_URL тесты SKIP
//   npm run verify:integration   — без TEST_DATABASE_URL тесты ПАДАЮТ
// ВНИМАНИЕ: тест применяет схему (runMigration) — указывайте отдельную БД.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { fork } = require('node:child_process');

const { dbTestOptions, getDb, closeDb } = require('../helpers/testDb');

const OPTS = dbTestOptions();
const TENDER = `t_jobs_it_${process.pid}`;

let db = null;
let queue = null;
let M = null;
let advisoryLock = null;
let createWorker = null;

const silent = { log: () => {}, warn: () => {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ждёт условие, опрашивая его; без таймаутов «на глазок» в самих тестах.
async function waitFor(fn, { timeoutMs = 15_000, stepMs = 100, what = 'условие' } = {}) {
  const t0 = Date.now();
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`Таймаут ожидания: ${what}`);
    // eslint-disable-next-line no-await-in-loop
    await sleep(stepMs);
  }
}

before(async () => {
  if (OPTS.skip) return;
  db = getDb();
  queue = require('../../services/jobs/jobQueue');
  M = require('../../services/jobs/jobModel');
  advisoryLock = require('../../services/jobs/advisoryLock');
  ({ createWorker } = require('../../services/jobs/worker'));

  const { runMigration } = require('../../db/migrate');
  try {
    await runMigration();
  } catch (_e) {
    // Файлы integration-тестов node --test запускает параллельно: два
    // одновременных CREATE TABLE IF NOT EXISTS могут столкнуться. Один повтор.
    await sleep(500);
    await runMigration();
  }
  await db.exec(`
    CREATE TABLE IF NOT EXISTS _jobs_test_log (
      id TEXT PRIMARY KEY, task_id TEXT, worker_id TEXT, worker_pid TEXT, at TEXT
    );
  `);
  await db.queryRun('DELETE FROM _jobs_test_log');
  await db.queryRun('DELETE FROM tenders WHERE id = ?', TENDER);
  await db.queryRun(
    'INSERT INTO tenders (id, title, status, created_at) VALUES (?, ?, ?, ?)',
    TENDER, 'Очередь: integration-тест', 'draft', new Date().toISOString(),
  );
});

after(async () => {
  if (OPTS.skip) return;
  try {
    await db.queryRun('DELETE FROM tenders WHERE id = ?', TENDER);
    await db.exec('DROP TABLE IF EXISTS _jobs_test_log');
  } finally {
    await closeDb();
  }
});

// Задание с задачами указанного типа. scopeKey уникален на тест, чтобы
// advisory-lock не сериализовал то, что мы хотим проверить параллельно.
function enqueue(spec) {
  return queue.enqueueJob({
    tenderId: TENDER,
    jobType: 'test_job',
    documentsRevisionId: 'docs_it',
    configVersion: 'cfg_it',
    exclusiveScope: false,
    ...spec,
  });
}

function worker(id, handlers, extra = {}) {
  return createWorker({
    handlers, workerId: id, logger: silent,
    leaseMs: 15_000, heartbeatMs: 5_000, pollIntervalMs: 50, ...extra,
  });
}

// --- 1. Повторный запуск: без дублей --------------------------------------------------

test('повторный запуск того же прогона не создаёт второе задание (ключ идемпотентности)', OPTS, async () => {
  const spec = {
    scopeKey: 'it:idem',
    tasks: [{ taskKey: 'main', taskType: 'test_noop' }],
  };
  const a = await enqueue(spec);
  const b = await enqueue(spec);

  assert.equal(a.deduped, null, 'первый запуск создаёт задание');
  assert.equal(b.deduped, 'active', 'второй — попадает в уже живое');
  assert.equal(b.job.id, a.job.id);

  const rows = await db.queryAll(
    'SELECT id FROM analysis_jobs WHERE tender_id = ? AND scope_key = ?', TENDER, 'it:idem',
  );
  assert.equal(rows.length, 1, 'в БД ровно одно задание');
  const tasks = await queue.getTasks(a.job.id);
  assert.equal(tasks.length, 1, 'задачи тоже не задвоились');
  await queue.requestCancel(a.job.id);
});

test('ОДНОВРЕМЕННЫЕ запросы: гонку разрешает БД — задание всё равно одно', OPTS, async () => {
  const spec = { scopeKey: 'it:idem:race', tasks: [{ taskKey: 'main', taskType: 'test_noop' }] };
  const results = await Promise.all([enqueue(spec), enqueue(spec), enqueue(spec), enqueue(spec)]);
  const ids = new Set(results.map((r) => r.job.id));
  assert.equal(ids.size, 1, 'все четыре запроса указывают на одно задание');

  const rows = await db.queryAll(
    'SELECT id FROM analysis_jobs WHERE tender_id = ? AND scope_key = ?', TENDER, 'it:idem:race',
  );
  assert.equal(rows.length, 1, 'частичный UNIQUE-индекс не дал создать дубль');
  await queue.requestCancel([...ids][0]);
});

test('завершённое задание не мешает запустить прогон заново (ключ освобождается)', OPTS, async () => {
  const spec = { scopeKey: 'it:rerun', tasks: [{ taskKey: 'main', taskType: 'test_ok' }] };
  const first = await enqueue(spec);
  const w = worker('w-rerun', { test_ok: async () => ({ ok: true }) }, { taskTypes: ['test_ok'] });
  const done = await w.runOnce();
  assert.equal(done.status, 'completed');
  assert.equal((await queue.getJob(first.job.id)).status, 'completed');

  const second = await enqueue(spec);
  assert.equal(second.deduped, null, 'после завершения тот же прогон можно запустить снова');
  assert.notEqual(second.job.id, first.job.id);
  await queue.requestCancel(second.job.id);
});

// --- 2. FOR UPDATE SKIP LOCKED ---------------------------------------------------------

test('два воркера в параллель: каждая задача выполнена ровно один раз', OPTS, async () => {
  const N = 8;
  const jobIds = [];
  for (let i = 0; i < N; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const { job } = await enqueue({
      scopeKey: `it:par:${i}`,
      tasks: [{ taskKey: `t${i}`, taskType: 'test_par' }],
    });
    jobIds.push(job.id);
  }

  const executed = [];
  const handler = async (ctx) => {
    executed.push(ctx.task.id);
    await sleep(20); // окно, в котором второй воркер мог бы схватить ту же строку
    return { by: ctx.workerId };
  };
  const w1 = worker('w-par-1', { test_par: handler }, { taskTypes: ['test_par'] });
  const w2 = worker('w-par-2', { test_par: handler }, { taskTypes: ['test_par'] });
  const drain = async (w) => { let r; do { r = await w.runOnce(); } while (r); }; // eslint-disable-line no-await-in-loop
  await Promise.all([drain(w1), drain(w2)]);

  assert.equal(executed.length, N, 'выполнений ровно столько, сколько задач');
  assert.equal(new Set(executed).size, N, 'ни одна задача не выполнялась дважды');
  const rows = await db.queryAll(
    `SELECT t.status, t.attempts FROM analysis_tasks t
      WHERE t.job_id = ANY(?::text[])`,
    jobIds,
  );
  assert.equal(rows.length, N);
  assert.ok(rows.every((r) => r.status === 'completed'), 'все задачи завершены успешно');
  assert.ok(rows.every((r) => Number(r.attempts) === 1), 'по одной попытке на задачу');
});

// --- 3. Два ПРОЦЕССА-воркера ------------------------------------------------------------

test('два worker-ПРОЦЕССА разбирают очередь без дублей', OPTS, async (t) => {
  const N = 10;
  for (let i = 0; i < N; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await enqueue({
      scopeKey: `it:proc:${i}`,
      tasks: [{ taskKey: `p${i}`, taskType: 'test_exec', payload: { sleepMs: 15 } }],
    });
  }

  const script = path.join(__dirname, '..', 'helpers', 'queueWorkerProc.js');
  const kids = [fork(script, ['a'], { stdio: 'ignore' }), fork(script, ['b'], { stdio: 'ignore' })];
  t.after(async () => {
    for (const k of kids) if (!k.killed) k.kill('SIGKILL');
  });
  const ready = await Promise.all(kids.map((k) => new Promise((resolve, reject) => {
    k.once('message', (m) => (m && m.ready ? resolve(m) : reject(new Error(m && m.error))));
    k.once('exit', (code) => reject(new Error(`воркер-процесс завершился с кодом ${code}`)));
  })));
  assert.equal(new Set(ready.map((r) => r.pid)).size, 2, 'подняты два разных процесса');

  await waitFor(async () => {
    const row = await db.queryOne(
      `SELECT COUNT(*) AS c FROM analysis_tasks
        WHERE tender_id = ? AND task_type = 'test_exec' AND status <> 'completed'`, TENDER,
    );
    return Number(row.c) === 0;
  }, { what: 'все задачи разобраны двумя процессами' });

  const log = await db.queryAll('SELECT task_id, worker_pid FROM _jobs_test_log');
  assert.equal(log.length, N, `выполнений ${log.length}, ожидалось ${N} — дублей быть не должно`);
  assert.equal(new Set(log.map((r) => r.task_id)).size, N, 'каждая задача выполнена один раз');
  assert.equal(new Set(log.map((r) => r.worker_pid)).size, 2, 'работали оба процесса');

  await Promise.all(kids.map((k) => new Promise((resolve) => {
    k.once('exit', resolve);
    k.send('stop');
  })));
});

// --- 4. Advisory-lock ---------------------------------------------------------------------

test('advisory-lock: второй прогон той же стадии и ревизии не стартует, пока идёт первый', OPTS, async (t) => {
  const { job } = await enqueue({
    scopeKey: 'it:lock', tasks: [{ taskKey: 'main', taskType: 'test_lock' }],
  });
  const fresh = await queue.getJob(job.id);

  // Чужая сессия (другой процесс/воркер) уже считает эту стадию.
  const held = await advisoryLock.acquire(fresh.lock_key);
  // Замок держит ВЫДЕЛЕННОЕ соединение — не отпустив его, мы бы подвесили пул.
  t.after(() => held && held.release());
  assert.ok(held, 'замок взят первой сессией');
  assert.equal(await advisoryLock.acquire(fresh.lock_key), null, 'вторая сессия замок не получает');
  assert.equal(await advisoryLock.isHeld(fresh.lock_key), true);

  let runs = 0;
  const w = worker('w-lock', { test_lock: async () => { runs += 1; return {}; } }, { taskTypes: ['test_lock'], busyDelayMs: 0 });
  const busy = await w.runOnce();
  assert.equal(busy.status, 'busy', 'воркер увидел занятую область');
  assert.equal(runs, 0, 'анализ той же стадии/ревизии второй раз не запускался');
  const back = (await queue.getTasks(job.id))[0];
  assert.equal(back.status, 'queued', 'задача вернулась в очередь');
  assert.equal(Number(back.attempts), 0, 'попытка не израсходована — работы не было');

  await held.release();
  assert.equal(await advisoryLock.isHeld(fresh.lock_key), false, 'замок освобождён');
  const okRes = await w.runOnce();
  assert.equal(okRes.status, 'completed');
  assert.equal(runs, 1);
});

test('advisory-lock: разные стадии одного тендера считаются параллельно', OPTS, async (t) => {
  const k1 = M.advisoryLockKey(TENDER, 'stage:1', 'docs_it');
  const k2 = M.advisoryLockKey(TENDER, 'stage:2', 'docs_it');
  const l1 = await advisoryLock.acquire(k1);
  const l2 = await advisoryLock.acquire(k2);
  t.after(async () => { if (l1) await l1.release(); if (l2) await l2.release(); });
  assert.ok(l1 && l2, 'замки разных стадий не мешают друг другу');
});

// --- 5. Рестарт: продолжение или interrupted ------------------------------------------------

test('рестарт: задача умершего воркера возвращается в очередь и ПРОДОЛЖАЕТСЯ с чекпойнта', OPTS, async () => {
  const { job } = await enqueue({
    scopeKey: 'it:restart', tasks: [{ taskKey: 'main', taskType: 'test_resume', maxAttempts: 3 }],
  });

  // Воркер взял задачу, записал чекпойнт и «умер» (аренда 1 мс, никаких finally).
  const claimed = await queue.claimTask({ workerId: 'w-dead', leaseMs: 1, taskTypes: ['test_resume'] });
  assert.ok(claimed && claimed.job_id === job.id);
  await queue.heartbeat({
    taskId: claimed.id, workerId: 'w-dead', leaseMs: 1,
    progressTotal: 4, progressDone: 2, checkpoint: { parts: { 0: 'A', 1: 'B' } },
  });
  assert.equal((await queue.getJob(job.id)).status, 'running');

  await sleep(50); // аренда истекла
  const reaped = await queue.reapExpiredTasks({});
  assert.ok(reaped.requeued >= 1, 'осиротевшая задача возвращена в очередь');
  const requeued = (await queue.getTasks(job.id))[0];
  assert.equal(requeued.status, 'queued');
  assert.ok(requeued.checkpoint_json, 'чекпойнт пережил гибель воркера');
  assert.deepEqual(JSON.parse(requeued.checkpoint_json), { parts: { 0: 'A', 1: 'B' } });

  // Мёртвый воркер, если вдруг «оживёт», уже ничего не испортит.
  const zombie = await queue.heartbeat({ taskId: claimed.id, workerId: 'w-dead', leaseMs: 1000 });
  assert.equal(zombie.ok, false, 'потерявший аренду воркер отсекается');

  let seenCheckpoint = null;
  const w = worker('w-restarted', {
    test_resume: async (ctx) => { seenCheckpoint = ctx.checkpoint; return { ok: true }; },
  }, { taskTypes: ['test_resume'] });
  const res = await w.runOnce();
  assert.equal(res.status, 'completed');
  assert.deepEqual(seenCheckpoint, { parts: { 0: 'A', 1: 'B' } }, 'продолжили с чекпойнта, а не с нуля');
  assert.equal((await queue.getJob(job.id)).status, 'completed');
});

test('рестарт: когда попытки исчерпаны — задача и задание получают статус interrupted', OPTS, async () => {
  const { job } = await enqueue({
    scopeKey: 'it:interrupted', tasks: [{ taskKey: 'main', taskType: 'test_dead', maxAttempts: 1 }],
  });
  const claimed = await queue.claimTask({ workerId: 'w-dead-2', leaseMs: 1, taskTypes: ['test_dead'] });
  assert.ok(claimed && claimed.job_id === job.id);
  await sleep(50);

  const reaped = await queue.reapExpiredTasks({});
  assert.ok(reaped.interrupted >= 1);
  const task = (await queue.getTasks(job.id))[0];
  assert.equal(task.status, 'interrupted');
  const after = await queue.getJob(job.id);
  assert.equal(after.status, 'interrupted', 'задание корректно помечено оборванным, а не «упало»');
  assert.ok(after.finished_at, 'терминальный статус проставляет finished_at');
});

test('аварийная гибель ПРОЦЕССА-воркера: задача не зависает — reaper возвращает её в очередь', OPTS, async (t) => {
  const { job } = await enqueue({
    scopeKey: 'it:proc:kill',
    tasks: [{ taskKey: 'main', taskType: 'test_exec', maxAttempts: 3, payload: { sleepMs: 60_000 } }],
  });
  const script = path.join(__dirname, '..', 'helpers', 'queueWorkerProc.js');
  const kid = fork(script, ['killme'], { stdio: 'ignore' });
  t.after(() => { if (!kid.killed) kid.kill('SIGKILL'); });
  await new Promise((resolve, reject) => {
    kid.once('message', (m) => (m && m.ready ? resolve(m) : reject(new Error('воркер не поднялся'))));
  });

  const claimed = await waitFor(async () => {
    const rows = await queue.getTasks(job.id);
    return rows[0].status === 'running' ? rows[0] : null;
  }, { what: 'процесс-воркер взял задачу' });
  assert.ok(claimed.locked_by, 'аренда за живым процессом');

  // Убиваем процесс на середине работы (никакой мягкой остановки).
  await new Promise((resolve) => { kid.once('exit', resolve); kid.send('kill'); });

  // Аренда ещё жива — задача НЕ должна перехватываться раньше времени.
  const stillRunning = (await queue.getTasks(job.id))[0];
  assert.equal(stillRunning.status, 'running');

  // Досрочно «состариваем» аренду, чтобы не ждать 15 секунд реального таймаута.
  await db.queryRun(
    `UPDATE analysis_tasks SET lease_expires_at = ? WHERE id = ?`,
    '2000-01-01T00:00:00.000Z', claimed.id,
  );
  const reaped = await queue.reapExpiredTasks({});
  assert.ok(reaped.requeued >= 1, 'после гибели процесса задача вернулась в очередь');
  assert.equal((await queue.getTasks(job.id))[0].status, 'queued');
  await queue.requestCancel(job.id);
});

// --- 6. Прогресс, чекпойнт и отмена в БД ------------------------------------------------------

test('прогресс задачи и задания пишется в БД (переживает рестарт процесса)', OPTS, async () => {
  const { job } = await enqueue({
    scopeKey: 'it:progress', tasks: [{ taskKey: 'main', taskType: 'test_progress' }],
  });
  const w = worker('w-progress', {
    test_progress: async (ctx) => {
      await ctx.setTotal(3);
      await ctx.tick();
      // Прогресс уже в БД — читаем его «другим процессом» (обычным запросом).
      const mid = await db.queryOne('SELECT progress_total, progress_done FROM analysis_jobs WHERE id = ?', ctx.job.id);
      assert.equal(Number(mid.progress_total), 3);
      assert.equal(Number(mid.progress_done), 1);
      await ctx.tick();
      await ctx.tick();
      return { ok: true };
    },
  }, { taskTypes: ['test_progress'] });

  const res = await w.runOnce();
  assert.equal(res.status, 'completed');
  const done = await queue.getJob(job.id);
  assert.equal(Number(done.progress_done), 3);
  assert.equal(Number(done.progress_total), 3);
});

test('отмена: задание снимается, бегущая задача узнаёт об этом на heartbeat', OPTS, async () => {
  const { job } = await enqueue({
    scopeKey: 'it:cancel', tasks: [{ taskKey: 'main', taskType: 'test_cancel' }],
  });
  const w = worker('w-cancel', {
    test_cancel: async (ctx) => {
      await queue.requestCancel(ctx.job.id); // инженер нажал «Отменить»
      await ctx.tick();                      // heartbeat приносит флаг отмены
      ctx.guard();                           // кооперативно прерываемся
      return { never: true };
    },
  }, { taskTypes: ['test_cancel'] });

  const res = await w.runOnce();
  assert.equal(res.status, 'cancelled');
  assert.equal((await queue.getTasks(job.id))[0].status, 'cancelled');
  assert.equal((await queue.getJob(job.id)).status, 'cancelled');
});

test('отменённое задание больше не выдаётся воркеру', OPTS, async () => {
  const { job } = await enqueue({
    scopeKey: 'it:cancel:queued', tasks: [{ taskKey: 'main', taskType: 'test_never' }],
  });
  await queue.requestCancel(job.id);
  const w = worker('w-cancel-2', { test_never: async () => { throw new Error('не должно выполниться'); } }, { taskTypes: ['test_never'] });
  assert.equal(await w.runOnce(), null);
  assert.equal((await queue.getJob(job.id)).status, 'cancelled');
});

// --- 7. Связка со стадиями анализа ----------------------------------------------------------------

test('стадия не остаётся в «running» навсегда: финализатор задания чинит статус и пишет исход', OPTS, async () => {
  const engine = require('../../services/stageAnalysis/stageAnalysisEngine');
  const { jobFinalizers } = require('../../services/jobs/handlers');

  await db.queryRun('DELETE FROM tender_stage_state WHERE tender_id = ?', TENDER);
  await db.queryRun(
    `INSERT INTO tender_stage_state (tender_id, current_stage, stage1_status, stage2_status, stage3_status, stage4_status, stage5_status)
     VALUES (?, 1, 'running', 'locked', 'locked', 'locked', 'locked')`,
    TENDER,
  );
  const { job } = await enqueue({
    jobType: 'stage_analysis',
    scopeKey: 'stage:1',
    payload: { stage: 1, prev_status: 'open' },
    tasks: [{ taskKey: 'stage:1', taskType: 'stage_analysis', maxAttempts: 1 }],
  });
  // Как в production: прогон заводится ПРИ ПОСТАНОВКЕ в очередь (status='running',
  // реальные started_at / ревизия / версия конфигурации), его id — в задании.
  // Финализатор обязан завершить ИМЕННО ЕГО, а не создавать вторую строку.
  const { runId } = await engine.beginStageRun(TENDER, 1, { reason: 'it:job' });
  await db.queryRun('UPDATE analysis_jobs SET analysis_run_id = ? WHERE id = ?', runId, job.id);
  const runsBefore = await db.queryOne(
    'SELECT COUNT(*) AS c FROM analysis_runs WHERE tender_id = ? AND stage = 1', TENDER,
  );

  // Прогон оборван рестартом: аренда истекла, попытки исчерпаны → interrupted.
  const claimed = await queue.claimTask({ workerId: 'w-stage-dead', leaseMs: 1, taskTypes: ['stage_analysis'] });
  assert.ok(claimed && claimed.job_id === job.id);
  await sleep(50);
  await queue.reapExpiredTasks({});
  const settled = await queue.getJob(job.id);
  assert.equal(settled.status, 'interrupted');

  await jobFinalizers.stage_analysis({ job: settled, tasks: await queue.getTasks(job.id) });

  const state = await engine.getStageState(TENDER);
  assert.equal(state.stage1_status, 'open', 'стадия снова запускаема, кольцо прогресса не крутится вечно');
  const run = await engine.getStageRunSummary(TENDER, 1);
  assert.equal(run.id, runId, 'завершён ТОТ ЖЕ прогон — отдельной фиктивной строки не появляется');
  assert.equal(engine.classifyStageRun(run), 'interrupted', 'исход виден как «оборван», а не «успех»');
  assert.match(run.summary.error, /прерван|оборван/i, 'в сводке видно, почему прогон не досчитан');
  assert.ok(run.started_at && run.finished_at, 'у прогона реальные времена начала и конца');
  const runsAfter = await db.queryOne(
    'SELECT COUNT(*) AS c FROM analysis_runs WHERE tender_id = ? AND stage = 1', TENDER,
  );
  assert.equal(Number(runsAfter.c), Number(runsBefore.c), 'число прогонов не выросло: исход записан в начатый');

  // Живого задания на область больше нет — «зомби»-починка на старте сервера
  // такую стадию уже не трогает (её и так починил финализатор).
  assert.equal(await queue.getActiveJobForScope(TENDER, 'stage:1'), undefined);
  await db.queryRun('DELETE FROM tender_stage_state WHERE tender_id = ?', TENDER);
  await db.queryRun('DELETE FROM analysis_runs WHERE tender_id = ?', TENDER);
});

test('recoverOrphanedRunningStages: чинит стадию без задания и НЕ трогает стадию с живым заданием', OPTS, async () => {
  const engine = require('../../services/stageAnalysis/stageAnalysisEngine');
  await db.queryRun('DELETE FROM tender_stage_state WHERE tender_id = ?', TENDER);
  await db.queryRun(
    `INSERT INTO tender_stage_state (tender_id, current_stage, stage1_status, stage2_status, stage3_status, stage4_status, stage5_status)
     VALUES (?, 2, 'running', 'running', 'locked', 'locked', 'locked')`,
    TENDER,
  );
  // Стадия 2 считается живым воркером (другой процесс), стадия 1 — осиротела.
  const { job } = await enqueue({
    jobType: 'stage_analysis', scopeKey: 'stage:2',
    payload: { stage: 2 },
    tasks: [{ taskKey: 'stage:2', taskType: 'test_never_claimed' }],
  });

  await engine.recoverOrphanedRunningStages();
  const state = await engine.getStageState(TENDER);
  assert.equal(state.stage1_status, 'open', 'стадия без задания сброшена');
  assert.equal(state.stage2_status, 'running', 'стадию с живым заданием рестарт API не сбивает');

  await queue.requestCancel(job.id);
  await db.queryRun('DELETE FROM tender_stage_state WHERE tender_id = ?', TENDER);
});

// --- 8. Задание из нескольких шагов ---------------------------------------------------------------

test('шаги задания идут по порядку; после сбоя шага остальные skipped, финализатор отрабатывает', OPTS, async () => {
  const { job } = await enqueue({
    scopeKey: 'it:steps',
    tasks: [
      { taskKey: 'begin', taskType: 'test_step', seq: 0 },
      { taskKey: 'step:a', taskType: 'test_step', seq: 1 },
      { taskKey: 'step:b', taskType: 'test_step', seq: 2, maxAttempts: 1 },
      { taskKey: 'step:c', taskType: 'test_step', seq: 3 },
      { taskKey: 'finalize', taskType: 'test_final', seq: 4, alwaysRun: true },
    ],
  });
  const order = [];
  const w = worker('w-steps', {
    test_step: async (ctx) => {
      order.push(ctx.task.task_key);
      if (ctx.task.task_key === 'step:b') throw Object.assign(new Error('шаг упал'), { status: 400 });
      return { ok: true };
    },
    test_final: async (ctx) => { order.push('finalize'); return { seen: (await ctx.store.getTasks(ctx.job.id)).length }; },
  }, { taskTypes: ['test_step', 'test_final'] });

  for (let i = 0; i < 6; i += 1) await w.runOnce(); // eslint-disable-line no-await-in-loop

  assert.deepEqual(order, ['begin', 'step:a', 'step:b', 'finalize']);
  const byKey = Object.fromEntries((await queue.getTasks(job.id)).map((x) => [x.task_key, x.status]));
  assert.deepEqual(byKey, {
    begin: 'completed', 'step:a': 'completed', 'step:b': 'failed', 'step:c': 'skipped', finalize: 'completed',
  });
  assert.equal((await queue.getJob(job.id)).status, 'failed');
});
