'use strict';

// Фейковый стор очереди для ОФЛАЙН-тестов цикла воркера (без Postgres).
// Повторяет контракт services/jobs/jobQueue и — что важнее — те же ПРАВИЛА:
// готовность задачи, порядок выборки, свод статуса задания и восстановление
// после истёкшей аренды берутся из того же чистого ядра (services/jobs/jobModel),
// что и боевой SQL. Поэтому офлайн-тест проверяет логику цикла, а integration —
// что SQL реализует те же правила на живой БД.
//
// «Атомарность» claim моделируется тем, что выборка и захват выполняются
// синхронно, без await между ними, — как одна SQL-инструкция
// UPDATE ... FOR UPDATE SKIP LOCKED.

const M = require('../../services/jobs/jobModel');

let seq = 0;
const nextId = (p) => `${p}_${String(++seq).padStart(4, '0')}`;

function createFakeQueue({ nowMs = () => Date.now() } = {}) {
  const jobs = new Map();
  const tasks = new Map();
  const iso = () => new Date(nowMs()).toISOString();

  const taskList = (jobId) => [...tasks.values()].filter((t) => t.job_id === jobId)
    .sort((a, b) => a.seq - b.seq);

  function addJob(spec = {}) {
    const id = spec.id || nextId('job');
    const job = {
      id,
      tender_id: spec.tenderId || 't1',
      job_type: spec.jobType || 'test',
      scope_key: spec.scopeKey || 'test:1',
      idempotency_key: spec.idempotencyKey || nextId('idem'),
      lock_key: spec.lockKey || M.advisoryLockKey(spec.tenderId || 't1', spec.scopeKey || 'test:1'),
      analysis_run_id: null,
      status: 'queued',
      cancel_requested: 0,
      payload_json: spec.payload ? JSON.stringify(spec.payload) : null,
      result_json: null,
      error: null,
      progress_total: 0,
      progress_done: 0,
      created_at: iso(),
      started_at: null,
      finished_at: null,
      updated_at: iso(),
    };
    jobs.set(id, job);
    (spec.tasks || [{ taskKey: 'main', taskType: spec.taskType || 'test' }]).forEach((t, i) => {
      const tid = t.id || nextId('task');
      tasks.set(tid, {
        id: tid,
        job_id: id,
        tender_id: job.tender_id,
        task_key: t.taskKey || `task${i}`,
        task_type: t.taskType || 'test',
        seq: t.seq ?? i,
        always_run: t.alwaysRun ? 1 : 0,
        status: t.status || 'queued',
        attempts: t.attempts || 0,
        max_attempts: t.maxAttempts ?? 3,
        priority: t.priority ?? 100,
        run_after: t.runAfter || iso(),
        locked_by: t.lockedBy || null,
        locked_at: null,
        heartbeat_at: null,
        lease_expires_at: t.leaseExpiresAt || null,
        progress_total: 0,
        progress_done: 0,
        checkpoint_json: t.checkpoint ? JSON.stringify(t.checkpoint) : null,
        payload_json: t.payload ? JSON.stringify(t.payload) : null,
        result_json: null,
        error: null,
        created_at: iso(),
        started_at: null,
        finished_at: null,
        updated_at: iso(),
      });
    });
    return { job, tasks: taskList(id) };
  }

  const store = {
    _jobs: jobs,
    _tasks: tasks,
    addJob,
    async getJob(id) { return jobs.get(id) || null; },
    async getTask(id) { return tasks.get(id) || null; },
    async getTasks(jobId) { return taskList(jobId); },

    async claimTask({ workerId, leaseMs = 60_000, taskTypes = null }) {
      const now = iso();
      const all = [...tasks.values()];
      const ready = all
        .filter((t) => !taskTypes || taskTypes.includes(t.task_type))
        .filter((t) => {
          const job = jobs.get(t.job_id);
          if (!job || !M.ACTIVE_JOB_STATUSES.includes(job.status) || Number(job.cancel_requested)) return false;
          return M.isTaskReady(t, all, now);
        })
        .sort(M.compareClaimOrder);
      const task = ready[0];
      if (!task) return null;
      task.status = 'running';
      task.attempts += 1;
      task.locked_by = workerId;
      task.locked_at = now;
      task.heartbeat_at = now;
      task.lease_expires_at = new Date(nowMs() + leaseMs).toISOString();
      task.started_at = task.started_at || now;
      task.error = null;
      task.updated_at = now;
      const job = jobs.get(task.job_id);
      if (job.status === 'queued') {
        job.status = 'running';
        job.started_at = job.started_at || now;
      }
      return { ...task };
    },

    async heartbeat({ taskId, workerId, leaseMs = 60_000, progressDone = null, progressTotal = null, checkpoint = undefined }) {
      const task = tasks.get(taskId);
      if (!task || task.locked_by !== workerId || task.status !== 'running') {
        return { ok: false, cancelRequested: false };
      }
      task.heartbeat_at = iso();
      task.lease_expires_at = new Date(nowMs() + leaseMs).toISOString();
      if (progressDone != null) task.progress_done = Number(progressDone);
      if (progressTotal != null) task.progress_total = Number(progressTotal);
      if (checkpoint !== undefined && checkpoint !== null) task.checkpoint_json = JSON.stringify(checkpoint);
      await store.syncJobProgress(task.job_id);
      const job = jobs.get(task.job_id);
      return { ok: true, cancelRequested: Boolean(job && Number(job.cancel_requested)) };
    },

    async syncJobProgress(jobId) {
      const job = jobs.get(jobId);
      if (!job) return null;
      const p = M.rollupProgress(taskList(jobId));
      job.progress_total = p.total;
      job.progress_done = p.done;
      return p;
    },

    async completeTask({ taskId, workerId, result = null }) {
      const task = tasks.get(taskId);
      if (!task || task.locked_by !== workerId || task.status !== 'running') return null;
      task.status = 'completed';
      task.result_json = result == null ? null : JSON.stringify(result);
      task.error = null;
      task.finished_at = iso();
      task.progress_done = Math.max(task.progress_done, task.progress_total);
      task.locked_by = null;
      task.lease_expires_at = null;
      return { ...task };
    },

    async failTask({ taskId, workerId, error, retryDelayMs = null }) {
      const task = tasks.get(taskId);
      if (!task || task.locked_by !== workerId || task.status !== 'running') return null;
      task.error = String((error && error.message) || error || 'ошибка');
      task.locked_by = null;
      task.lease_expires_at = null;
      if (retryDelayMs != null) {
        task.status = 'queued';
        task.run_after = new Date(nowMs() + retryDelayMs).toISOString();
      } else {
        task.status = 'failed';
        task.finished_at = iso();
        await store.skipDownstream(task.job_id, task.seq, 'предыдущий шаг не выполнен');
      }
      return { ...task };
    },

    async cancelTask({ taskId, workerId, reason = 'отменено' }) {
      const task = tasks.get(taskId);
      if (!task || task.locked_by !== workerId || task.status !== 'running') return null;
      task.status = 'cancelled';
      task.error = reason;
      task.finished_at = iso();
      task.locked_by = null;
      task.lease_expires_at = null;
      await store.skipDownstream(task.job_id, task.seq, reason);
      return { ...task };
    },

    async releaseTask({ taskId, workerId, delayMs = 0, reason = null }) {
      const task = tasks.get(taskId);
      if (!task || task.locked_by !== workerId || task.status !== 'running') return null;
      task.status = 'queued';
      task.attempts = Math.max(0, task.attempts - 1);
      task.locked_by = null;
      task.lease_expires_at = null;
      task.run_after = new Date(nowMs() + delayMs).toISOString();
      task.error = reason;
      return { ...task };
    },

    async skipDownstream(jobId, seq, reason) {
      for (const t of taskList(jobId)) {
        if (t.seq > seq && t.status === 'queued' && !t.always_run) {
          t.status = 'skipped';
          t.error = reason;
          t.finished_at = iso();
        }
      }
    },

    async finalizeJob(jobId) {
      const job = jobs.get(jobId);
      if (!job) return null;
      const list = taskList(jobId);
      const status = M.deriveJobStatus(list, { cancelRequested: Boolean(Number(job.cancel_requested)) });
      const p = M.rollupProgress(list);
      job.status = status;
      job.progress_total = p.total;
      job.progress_done = p.done;
      job.error = status === 'completed' ? null : (list.map((t) => t.error).filter(Boolean).slice(-1)[0] || null);
      job.finished_at = M.isTerminalJobStatus(status) ? (job.finished_at || iso()) : null;
      return { ...job, _tasks: list };
    },

    async requestCancel(jobId, { reason = 'отменено' } = {}) {
      const job = jobs.get(jobId);
      if (!job) return null;
      job.cancel_requested = 1;
      for (const t of taskList(jobId)) {
        if (t.status === 'queued') {
          t.status = 'cancelled';
          t.error = reason;
          t.finished_at = iso();
        }
      }
      return store.finalizeJob(jobId);
    },

    async reapExpiredTasks() {
      const now = iso();
      const out = { requeued: 0, interrupted: 0, jobs: [] };
      for (const t of tasks.values()) {
        if (!M.isLeaseExpired(t, now)) continue;
        const d = M.recoveryDecision({ attempts: t.attempts, maxAttempts: t.max_attempts });
        if (d.action === 'requeue') {
          t.status = 'queued';
          t.locked_by = null;
          t.lease_expires_at = null;
          t.run_after = now;
          t.error = `прервано (${d.reason}) — задача возвращена в очередь`;
          out.requeued += 1;
        } else {
          t.status = 'interrupted';
          t.locked_by = null;
          t.lease_expires_at = null;
          t.finished_at = now;
          t.error = `прервано (${d.reason}) — попытки исчерпаны`;
          out.interrupted += 1;
          // eslint-disable-next-line no-await-in-loop
          await store.skipDownstream(t.job_id, t.seq, 'предыдущий шаг оборван');
        }
        if (!out.jobs.includes(t.job_id)) out.jobs.push(t.job_id);
      }
      for (const id of out.jobs) {
        // eslint-disable-next-line no-await-in-loop
        await store.finalizeJob(id);
      }
      return out;
    },

    async releaseWorkerTasks(workerId, { delayMs = 0 } = {}) {
      let n = 0;
      const touched = new Set();
      for (const t of tasks.values()) {
        if (t.locked_by === workerId && t.status === 'running') {
          t.status = 'queued';
          t.attempts = Math.max(0, t.attempts - 1);
          t.locked_by = null;
          t.lease_expires_at = null;
          t.run_after = new Date(nowMs() + delayMs).toISOString();
          n += 1;
          touched.add(t.job_id);
        }
      }
      for (const id of touched) {
        // eslint-disable-next-line no-await-in-loop
        await store.finalizeJob(id);
      }
      return n;
    },
  };
  return store;
}

// Фейковый advisory-lock: одна карта на «кластер» тестов. По умолчанию свободен.
function createFakeAdvisory() {
  const held = new Map();
  return {
    held,
    async acquire(key) {
      const k = String(key);
      if (held.get(k)) return null;
      held.set(k, true);
      let released = false;
      return {
        key: k,
        async release() {
          if (released) return;
          released = true;
          held.delete(k);
        },
      };
    },
    // Занять замок «снаружи» (эмуляция чужого процесса, который уже считает).
    take(key) { held.set(String(key), true); return () => held.delete(String(key)); },
  };
}

module.exports = { createFakeQueue, createFakeAdvisory };
