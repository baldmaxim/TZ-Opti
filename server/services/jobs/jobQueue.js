'use strict';

// Устойчивая очередь фоновых задач на PostgreSQL (без Redis и без состояния в
// памяти процесса). Таблицы — analysis_jobs / analysis_tasks (db/schema.sql).
//
// Свойства, ради которых это сделано:
//   • ПЕРЕЖИВАЕТ РЕСТАРТ. Прогресс, чекпойнт и статус лежат в БД; после падения
//     сервера задача продолжится с чекпойнта либо получит статус interrupted.
//   • НЕТ ДУБЛЕЙ. Задачу забирает ровно один воркер (FOR UPDATE SKIP LOCKED +
//     аренда), повторный запуск того же прогона дедуплицируется по ключу
//     идемпотентности (частичный UNIQUE-индекс — гонку разрешает БД).
//   • НЕСКОЛЬКО ПРОЦЕССОВ. Воркеров можно запускать сколько угодно: они не
//     мешают друг другу, а одновременный анализ одной стадии одной ревизии
//     запрещён advisory-lock'ом (см. advisoryLock.js).
//
// Все времена — ISO-строки UTC, как во всей схеме. Берутся ОТ БД (NOW ниже), а
// не от часов процесса: воркеры могут жить на разных машинах, и аренда должна
// сравниваться в одних часах.

const db = require('../../db/connection');
const { newId } = require('../../utils/ids');
const { badRequest, conflict, notFound } = require('../../utils/errors');
const M = require('./jobModel');

// «Сейчас» и «сейчас + N мс» в формате new Date().toISOString() на стороне БД.
const NOW = `to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const AT = (ms) =>
  `to_char(((now() + interval '${Math.max(0, Math.round(Number(ms) || 0))} milliseconds') AT TIME ZONE 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const JOB_COLS = 'id, tender_id, job_type, scope_key, idempotency_key, lock_key, documents_revision_id, config_version, analysis_run_id, status, cancel_requested, payload_json, result_json, error, progress_total, progress_done, created_by, created_at, started_at, finished_at, updated_at';

const jsonOrNull = (v) => (v == null ? null : JSON.stringify(v));
const parseJson = (v) => {
  if (v == null || v === '') return null;
  try { return JSON.parse(v); } catch (_e) { return null; }
};

async function dbNow(runner = db) {
  const r = await runner.queryOne(`SELECT ${NOW} AS now`);
  return r.now;
}

// --- Чтение --------------------------------------------------------------------

async function getJob(jobId, runner = db) {
  return runner.queryOne('SELECT * FROM analysis_jobs WHERE id = ?', jobId);
}

async function getTasks(jobId, runner = db) {
  return runner.queryAll('SELECT * FROM analysis_tasks WHERE job_id = ? ORDER BY seq ASC, task_key ASC', jobId);
}

async function getTask(taskId, runner = db) {
  return runner.queryOne('SELECT * FROM analysis_tasks WHERE id = ?', taskId);
}

// Живое задание области (стадия/конвейер тендера) — тот самый гард «уже идёт».
async function getActiveJobForScope(tenderId, scopeKey, runner = db) {
  return runner.queryOne(
    `SELECT * FROM analysis_jobs
      WHERE tender_id = ? AND scope_key = ? AND status IN ('queued', 'running')
      ORDER BY created_at DESC LIMIT 1`,
    tenderId, scopeKey,
  );
}

async function findByIdempotencyKey(key, { activeOnly = true } = {}, runner = db) {
  const sql = activeOnly
    ? `SELECT * FROM analysis_jobs WHERE idempotency_key = ? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1`
    : `SELECT * FROM analysis_jobs WHERE idempotency_key = ? ORDER BY created_at DESC LIMIT 1`;
  return runner.queryOne(sql, key);
}

// Задание + задачи + сводный прогресс — представление для API/UI.
async function describeJob(jobId, runner = db) {
  const job = await getJob(jobId, runner);
  if (!job) return null;
  const tasks = await getTasks(jobId, runner);
  return viewJob(job, tasks);
}

function viewJob(job, tasks) {
  const progress = M.rollupProgress(tasks);
  return {
    ...job,
    cancel_requested: Boolean(Number(job.cancel_requested)),
    payload: parseJson(job.payload_json),
    result: parseJson(job.result_json),
    progress: { ...progress, started_at: job.started_at || null },
    tasks: (tasks || []).map((t) => ({
      id: t.id,
      task_key: t.task_key,
      task_type: t.task_type,
      seq: t.seq,
      status: t.status,
      attempts: t.attempts,
      max_attempts: t.max_attempts,
      progress: { total: Number(t.progress_total) || 0, done: Number(t.progress_done) || 0 },
      // Сам чекпойнт наружу не отдаём (может быть большим) — только факт наличия.
      has_checkpoint: Boolean(t.checkpoint_json),
      locked_by: t.locked_by || null,
      heartbeat_at: t.heartbeat_at || null,
      lease_expires_at: t.lease_expires_at || null,
      run_after: t.run_after || null,
      error: t.error || null,
      result: parseJson(t.result_json),
      started_at: t.started_at || null,
      finished_at: t.finished_at || null,
    })),
  };
}

async function listJobs(tenderId, { limit = 20, status = null } = {}) {
  const params = [tenderId];
  let sql = 'SELECT * FROM analysis_jobs WHERE tender_id = ?';
  if (status) { sql += ' AND status = ?'; params.push(status); }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(Math.min(200, Math.max(1, Number(limit) || 20)));
  const jobs = await db.queryAll(sql, ...params);
  const out = [];
  for (const j of jobs) {
    // eslint-disable-next-line no-await-in-loop
    out.push(viewJob(j, await getTasks(j.id)));
  }
  return out;
}

// --- Постановка в очередь --------------------------------------------------------

// Поставить задание. Идемпотентно: тот же прогон (тендер + область + ревизия
// документов + версия конфигурации) не создаёт второе задание — возвращается уже
// существующее с deduped-меткой. Гонку двух одновременных POST разрешает
// частичный UNIQUE-индекс, а не приложение.
//
// tasks: [{ taskKey, taskType, seq, alwaysRun, maxAttempts, priority, payload }]
// exclusiveScope=true — второе задание на ту же область (даже с другим ключом,
// например по новой ревизии документов) не ставится, пока живо текущее.
async function enqueueJob(spec) {
  const {
    tenderId,
    jobType,
    scopeKey,
    documentsRevisionId = null,
    configVersion = null,
    payload = null,
    tasks = [],
    idempotencyKey = null,
    exclusiveScope = true,
    createdBy = null,
    busyMessage = null,
  } = spec;

  if (!tenderId) throw badRequest('jobs: не указан тендер');
  if (!tasks.length) throw badRequest('jobs: задание без задач');

  const key = idempotencyKey || M.idempotencyKey({ tenderId, jobType, scopeKey, documentsRevisionId, configVersion });
  const explicit = Boolean(idempotencyKey);

  // Уже есть живое задание с этим ключом — это ПОВТОРНЫЙ запуск того же прогона.
  const active = await findByIdempotencyKey(key, { activeOnly: true });
  if (active) return { job: active, tasks: await getTasks(active.id), deduped: 'active' };
  // Явный ключ от клиента (Idempotency-Key) идемпотентен и после завершения:
  // ретрай HTTP-запроса не запускает анализ второй раз.
  if (explicit) {
    const done = await findByIdempotencyKey(key, { activeOnly: false });
    if (done) return { job: done, tasks: await getTasks(done.id), deduped: 'terminal' };
  }
  if (exclusiveScope) {
    const busy = await getActiveJobForScope(tenderId, scopeKey);
    if (busy) throw conflict(busyMessage || `Задание «${scopeKey}» уже выполняется. Дождитесь завершения.`, { job_id: busy.id });
  }

  const jobId = newId();
  const lockKey = M.advisoryLockKey(tenderId, scopeKey, documentsRevisionId || '');

  try {
    await db.transaction(async (tx) => {
      await tx.queryRun(
        `INSERT INTO analysis_jobs
           (id, tender_id, job_type, scope_key, idempotency_key, lock_key, documents_revision_id,
            config_version, status, cancel_requested, payload_json, progress_total, progress_done,
            created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, 0, 0, ?, ${NOW}, ${NOW})`,
        jobId, tenderId, jobType, scopeKey, key, lockKey, documentsRevisionId,
        configVersion, jsonOrNull(payload), createdBy,
      );
      for (const [i, t] of tasks.entries()) {
        await tx.queryRun(
          `INSERT INTO analysis_tasks
             (id, job_id, tender_id, task_key, task_type, seq, always_run, status, attempts,
              max_attempts, priority, run_after, payload_json, progress_total, progress_done,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ${NOW}, ?, 0, 0, ${NOW}, ${NOW})`,
          newId(), jobId, tenderId, t.taskKey, t.taskType, t.seq ?? i,
          t.alwaysRun ? 1 : 0, t.maxAttempts ?? M.RETRY_POLICY.maxAttempts,
          t.priority ?? 100, jsonOrNull(t.payload ?? null),
        );
      }
    });
  } catch (e) {
    // Гонка: параллельный POST успел создать задание с тем же ключом.
    if (e && e.code === '23505') {
      const raced = await findByIdempotencyKey(key, { activeOnly: false });
      if (raced) return { job: raced, tasks: await getTasks(raced.id), deduped: 'race' };
    }
    throw e;
  }

  return { job: await getJob(jobId), tasks: await getTasks(jobId), deduped: null };
}

// --- Выборка задачи воркером -----------------------------------------------------

// Атомарно взять ОДНУ готовую задачу: FOR UPDATE SKIP LOCKED — параллельные
// воркеры не ждут друг друга и никогда не получают одну и ту же строку.
// Попытка засчитывается здесь же (attempts+1), аренда — leaseMs.
async function claimTask({ workerId, leaseMs = 60_000, taskTypes = null } = {}) {
  const params = [workerId];
  let typeFilter = '';
  if (Array.isArray(taskTypes) && taskTypes.length) {
    typeFilter = ` AND c.task_type IN (${taskTypes.map(() => '?').join(', ')})`;
  }
  const sql = `
    UPDATE analysis_tasks AS t
       SET status = 'running',
           attempts = t.attempts + 1,
           locked_by = ?,
           locked_at = ${NOW},
           heartbeat_at = ${NOW},
           lease_expires_at = ${AT(leaseMs)},
           started_at = COALESCE(t.started_at, ${NOW}),
           error = NULL,
           updated_at = ${NOW}
     WHERE t.id = (
       SELECT c.id
         FROM analysis_tasks c
         JOIN analysis_jobs j ON j.id = c.job_id
        WHERE c.status = 'queued'
          AND c.run_after <= ${NOW}
          AND j.status IN ('queued', 'running')
          AND j.cancel_requested = 0${typeFilter}
          AND NOT EXISTS (
            SELECT 1 FROM analysis_tasks p
             WHERE p.job_id = c.job_id
               AND p.seq < c.seq
               AND ((c.always_run = 0 AND p.status NOT IN ('completed', 'skipped'))
                 OR (c.always_run = 1 AND p.status IN ('queued', 'running')))
          )
        ORDER BY c.priority ASC, c.run_after ASC, c.seq ASC, c.id ASC
        FOR UPDATE OF c SKIP LOCKED
        LIMIT 1
     )
    RETURNING t.*`;
  if (typeFilter) params.push(...taskTypes);
  const res = await db.queryRun(sql, ...params);
  const task = res.rows && res.rows[0];
  if (!task) return null;
  // Задание перешло в running (для UI и для дедупликации по области).
  await db.queryRun(
    `UPDATE analysis_jobs
        SET status = 'running', started_at = COALESCE(started_at, ${NOW}), updated_at = ${NOW}
      WHERE id = ? AND status = 'queued'`,
    task.job_id,
  );
  return task;
}

// --- Аренда, прогресс, чекпойнт ---------------------------------------------------

// Продлить аренду и заодно сохранить прогресс/чекпойнт. Возвращает
//   { ok: false } — задачу увели (аренда истекла и её перезабрали): воркер
//                   ОБЯЗАН прекратить работу, иначе будет дубль;
//   { ok: true, cancelRequested } — можно продолжать (или прерваться по отмене).
async function heartbeat({ taskId, workerId, leaseMs = 60_000, progressDone = null, progressTotal = null, checkpoint = undefined }) {
  const res = await db.queryRun(
    `UPDATE analysis_tasks
        SET heartbeat_at = ${NOW},
            lease_expires_at = ${AT(leaseMs)},
            progress_done = COALESCE(?::int, progress_done),
            progress_total = COALESCE(?::int, progress_total),
            checkpoint_json = COALESCE(?::text, checkpoint_json),
            updated_at = ${NOW}
      WHERE id = ? AND locked_by = ? AND status = 'running'
      RETURNING job_id, progress_done, progress_total`,
    progressDone == null ? null : Number(progressDone),
    progressTotal == null ? null : Number(progressTotal),
    checkpoint === undefined ? null : jsonOrNull(checkpoint),
    taskId, workerId,
  );
  const row = res.rows && res.rows[0];
  if (!row) return { ok: false, cancelRequested: false };
  await syncJobProgress(row.job_id);
  const job = await db.queryOne('SELECT cancel_requested FROM analysis_jobs WHERE id = ?', row.job_id);
  return { ok: true, cancelRequested: Boolean(job && Number(job.cancel_requested)) };
}

// Прогресс задания = свёртка прогресса его задач (см. jobModel.rollupProgress).
async function syncJobProgress(jobId) {
  const tasks = await getTasks(jobId);
  const p = M.rollupProgress(tasks);
  await db.queryRun(
    `UPDATE analysis_jobs SET progress_total = ?, progress_done = ?, updated_at = ${NOW} WHERE id = ?`,
    p.total, p.done, jobId,
  );
  return p;
}

// --- Завершение задачи -------------------------------------------------------------

// Все переходы условны по (locked_by, status='running'): воркер, потерявший
// аренду, не может ни закоммитить результат, ни испортить чужую попытку.
async function settleTask(taskId, workerId, patchSql, params = []) {
  const res = await db.queryRun(
    `UPDATE analysis_tasks SET ${patchSql}, updated_at = ${NOW}
      WHERE id = ? AND locked_by = ? AND status = 'running'
      RETURNING *`,
    ...params, taskId, workerId,
  );
  return (res.rows && res.rows[0]) || null;
}

async function completeTask({ taskId, workerId, result = null }) {
  const task = await settleTask(
    taskId, workerId,
    `status = 'completed', result_json = ?, error = NULL, finished_at = ${NOW},
     progress_done = GREATEST(progress_done, progress_total), locked_by = NULL, lease_expires_at = NULL`,
    [jsonOrNull(result)],
  );
  return task;
}

// Сбой задачи: либо повтор с задержкой (attempts уже израсходована), либо
// окончательный провал — тогда следующие шаги задания пропускаются (skipped),
// кроме финализаторов (always_run).
async function failTask({ taskId, workerId, error, retryDelayMs = null }) {
  const msg = String((error && error.message) || error || 'неизвестная ошибка');
  if (retryDelayMs != null) {
    return settleTask(
      taskId, workerId,
      `status = 'queued', error = ?, locked_by = NULL, locked_at = NULL, lease_expires_at = NULL,
       run_after = ${AT(retryDelayMs)}`,
      [msg],
    );
  }
  const task = await settleTask(
    taskId, workerId,
    `status = 'failed', error = ?, finished_at = ${NOW}, locked_by = NULL, lease_expires_at = NULL`,
    [msg],
  );
  if (task) await skipDownstream(task.job_id, task.seq, 'предыдущий шаг не выполнен');
  return task;
}

async function cancelTask({ taskId, workerId, reason = 'отменено инженером' }) {
  const task = await settleTask(
    taskId, workerId,
    `status = 'cancelled', error = ?, finished_at = ${NOW}, locked_by = NULL, lease_expires_at = NULL`,
    [reason],
  );
  if (task) await skipDownstream(task.job_id, task.seq, reason);
  return task;
}

// Вернуть задачу в очередь, НЕ расходуя попытку: воркер её не выполнял (занят
// advisory-lock области, останов процесса).
async function releaseTask({ taskId, workerId, delayMs = 1_000, reason = null }) {
  return settleTask(
    taskId, workerId,
    `status = 'queued', attempts = GREATEST(0, attempts - 1), locked_by = NULL, locked_at = NULL,
     lease_expires_at = NULL, run_after = ${AT(delayMs)}, error = ?`,
    [reason],
  );
}

async function skipDownstream(jobId, seq, reason) {
  await db.queryRun(
    `UPDATE analysis_tasks
        SET status = 'skipped', error = ?, finished_at = ${NOW}, updated_at = ${NOW}
      WHERE job_id = ? AND seq > ? AND status = 'queued' AND always_run = 0`,
    reason, jobId, seq,
  );
}

// --- Финализация задания ------------------------------------------------------------

// Свести статус задания из статусов задач (чистое правило — jobModel).
// Вызывается после каждого перехода задачи; идемпотентна.
async function finalizeJob(jobId, { result = undefined } = {}) {
  const job = await getJob(jobId);
  if (!job) return null;
  const tasks = await getTasks(jobId);
  const status = M.deriveJobStatus(tasks, { cancelRequested: Boolean(Number(job.cancel_requested)) });
  const p = M.rollupProgress(tasks);
  const terminal = M.isTerminalJobStatus(status);
  const err = tasks.map((t) => t.error).filter(Boolean).slice(-1)[0] || null;
  await db.queryRun(
    `UPDATE analysis_jobs
        SET status = ?,
            progress_total = ?, progress_done = ?,
            error = CASE WHEN ? = 'completed' THEN NULL ELSE ? END,
            result_json = COALESCE(?::text, result_json),
            started_at = COALESCE(started_at, ?),
            finished_at = CASE WHEN ?::boolean THEN COALESCE(finished_at, ${NOW}) ELSE NULL END,
            updated_at = ${NOW}
      WHERE id = ?`,
    status, p.total, p.done, status, err,
    result === undefined ? null : jsonOrNull(result),
    tasks.map((t) => t.started_at).filter(Boolean).sort()[0] || null,
    terminal, jobId,
  );
  return { ...(await getJob(jobId)), _tasks: tasks, _status: status };
}

// --- Отмена --------------------------------------------------------------------------

// Запросить отмену задания. Задачи в очереди отменяются сразу; уже бегущая
// задача снимается кооперативно — воркер видит флаг на ближайшем heartbeat.
async function requestCancel(jobId, { reason = 'отменено инженером' } = {}) {
  const job = await getJob(jobId);
  if (!job) throw notFound('Задание не найдено');
  if (M.isTerminalJobStatus(job.status)) {
    return { job: await describeJob(jobId), already_finished: true };
  }
  await db.queryRun(
    `UPDATE analysis_jobs SET cancel_requested = 1, updated_at = ${NOW} WHERE id = ?`, jobId,
  );
  await db.queryRun(
    `UPDATE analysis_tasks
        SET status = 'cancelled', error = ?, finished_at = ${NOW}, updated_at = ${NOW}
      WHERE job_id = ? AND status = 'queued'`,
    reason, jobId,
  );
  await finalizeJob(jobId);
  return { job: await describeJob(jobId), already_finished: false };
}

// --- Восстановление после падения/рестарта -------------------------------------------

// Задачи с истёкшей арендой = их воркер умер (рестарт сервера, kill, потеря
// связи). Есть попытки — возвращаем в очередь, работа ПРОДОЛЖИТСЯ с чекпойнта;
// попытки исчерпаны — статус interrupted (оборвана, а не «упала»).
// Условный UPDATE по прежней аренде: если два процесса чинят очередь
// одновременно, выиграет ровно один.
async function reapExpiredTasks({ limit = 50 } = {}) {
  const stale = await db.queryAll(
    `SELECT * FROM analysis_tasks
      WHERE status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < ${NOW})
      ORDER BY lease_expires_at ASC NULLS FIRST
      LIMIT ?`,
    Math.max(1, Number(limit) || 50),
  );
  const out = { requeued: 0, interrupted: 0, jobs: [] };
  for (const t of stale) {
    const decision = M.recoveryDecision({ attempts: t.attempts, maxAttempts: t.max_attempts });
    const guard = "id = ? AND status = 'running' AND locked_by IS NOT DISTINCT FROM ?::text";
    let res;
    if (decision.action === 'requeue') {
      // eslint-disable-next-line no-await-in-loop
      res = await db.queryRun(
        `UPDATE analysis_tasks
            SET status = 'queued', locked_by = NULL, lease_expires_at = NULL,
                run_after = ${NOW}, error = ?, updated_at = ${NOW}
          WHERE ${guard}`,
        `прервано (${decision.reason}) — задача возвращена в очередь`, t.id, t.locked_by,
      );
      if (res.changes) out.requeued += 1;
    } else {
      // eslint-disable-next-line no-await-in-loop
      res = await db.queryRun(
        `UPDATE analysis_tasks
            SET status = 'interrupted', locked_by = NULL, lease_expires_at = NULL,
                finished_at = ${NOW}, error = ?, updated_at = ${NOW}
          WHERE ${guard}`,
        `прервано (${decision.reason}) — попытки исчерпаны`, t.id, t.locked_by,
      );
      if (res.changes) {
        out.interrupted += 1;
        // eslint-disable-next-line no-await-in-loop
        await skipDownstream(t.job_id, t.seq, 'предыдущий шаг оборван');
      }
    }
    if (res.changes && !out.jobs.includes(t.job_id)) out.jobs.push(t.job_id);
  }
  for (const jobId of out.jobs) {
    // eslint-disable-next-line no-await-in-loop
    await finalizeJob(jobId);
  }
  return out;
}

// Мягкая остановка воркера: вернуть все свои бегущие задачи в очередь сразу,
// не дожидаясь истечения аренды (рестарт продолжит работу без паузы).
async function releaseWorkerTasks(workerId, { delayMs = 0 } = {}) {
  const res = await db.queryRun(
    `UPDATE analysis_tasks
        SET status = 'queued', attempts = GREATEST(0, attempts - 1), locked_by = NULL,
            lease_expires_at = NULL, run_after = ${AT(delayMs)},
            error = 'воркер остановлен — задача возвращена в очередь', updated_at = ${NOW}
      WHERE locked_by = ? AND status = 'running'
      RETURNING job_id`,
    workerId,
  );
  const jobIds = [...new Set((res.rows || []).map((r) => r.job_id))];
  for (const id of jobIds) {
    // eslint-disable-next-line no-await-in-loop
    await finalizeJob(id);
  }
  return res.changes || 0;
}

// Сводка очереди (для debug-страницы и тестов).
async function queueStats() {
  const rows = await db.queryAll(
    `SELECT status, COUNT(*) AS c FROM analysis_tasks GROUP BY status`,
  );
  const out = {};
  for (const r of rows) out[r.status] = Number(r.c);
  return out;
}

module.exports = {
  NOW,
  AT,
  JOB_COLS,
  dbNow,
  // чтение
  getJob,
  getTask,
  getTasks,
  describeJob,
  viewJob,
  listJobs,
  getActiveJobForScope,
  findByIdempotencyKey,
  // запись
  enqueueJob,
  claimTask,
  heartbeat,
  syncJobProgress,
  completeTask,
  failTask,
  cancelTask,
  releaseTask,
  skipDownstream,
  finalizeJob,
  requestCancel,
  reapExpiredTasks,
  releaseWorkerTasks,
  queueStats,
};
