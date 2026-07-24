'use strict';

// Чистое ядро устойчивой очереди фоновых задач: статусы, ключи, политика
// повторов, сведение статуса задания из его задач. Без БД и без побочных
// эффектов — офлайн-тесты (server/test/unit/jobsModel.test.js).
//
// Модель:
//   analysis_jobs  — ЗАДАНИЕ (то, что запросил пользователь: «прогнать стадию N»,
//                    «пересобрать конвейер»). Единица идемпотентности и отмены.
//   analysis_tasks — ЗАДАЧА (единица работы воркера: одна стадия / один шаг
//                    конвейера). Единица claim / lease / retry / checkpoint.
// Задание = упорядоченный набор задач: задача seq=k стартует, только когда все
// задачи с меньшим seq завершены (always_run — когда просто не осталось
// незавершённых, чтобы финализатор конвейера отработал и после сбоя шага).

const crypto = require('crypto');

const JOB_STATUS = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  INTERRUPTED: 'interrupted',
});

const TASK_STATUS = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  INTERRUPTED: 'interrupted',
  SKIPPED: 'skipped',
});

// Задание «живо» (занимает scope и участвует в дедупликации по ключу
// идемпотентности) ровно в этих статусах.
const ACTIVE_JOB_STATUSES = Object.freeze([JOB_STATUS.QUEUED, JOB_STATUS.RUNNING]);
// Задача ещё не завершена.
const PENDING_TASK_STATUSES = Object.freeze([TASK_STATUS.QUEUED, TASK_STATUS.RUNNING]);
// Задача завершена благополучно (не блокирует следующие по seq).
const PASSED_TASK_STATUSES = Object.freeze([TASK_STATUS.COMPLETED, TASK_STATUS.SKIPPED]);

const isPending = (s) => PENDING_TASK_STATUSES.includes(s);
const isPassed = (s) => PASSED_TASK_STATUSES.includes(s);

function sha1(s) {
  return crypto.createHash('sha1').update(String(s == null ? '' : s)).digest('hex');
}

// --- Ключи --------------------------------------------------------------------

// Ключ идемпотентности задания. Один и тот же запуск (тендер + область + ревизия
// документов + версия конфигурации) даёт ОДИН ключ, поэтому повторный клик/ретрай
// HTTP-запроса не создаёт второе задание — очередь вернёт уже существующее.
function idempotencyKey({ tenderId, jobType, scopeKey, documentsRevisionId, configVersion }) {
  const raw = [tenderId, jobType, scopeKey, documentsRevisionId || '', configVersion || ''].join('::');
  return `idem_${sha1(raw).slice(0, 32)}`;
}

// Ключ advisory-lock: детерминированное знаковое 64-битное число (строкой —
// в SQL приводится через ::bigint, чтобы не терять точность в JS number).
// Замок берётся на (тендер + область + ревизия документов): одновременный анализ
// одной стадии одной ревизии невозможен даже из разных процессов.
function advisoryLockKey(...parts) {
  const digest = crypto.createHash('sha1').update(parts.map((p) => String(p ?? '')).join('::')).digest();
  return BigInt.asIntN(64, digest.readBigUInt64BE(0)).toString();
}

const stageScopeKey = (stage) => `stage:${stage}`;
const SCOPE_PIPELINE = 'pipeline';

// --- Политика повторов ---------------------------------------------------------

const RETRY_POLICY = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 5_000,
  factor: 3,
  maxDelayMs: 5 * 60_000,
});

// Повторять имеет смысл только временные сбои. Явный флаг retryable сильнее
// всего; 4xx (гейт стадии, отсутствие Q&A, неверный запрос) — не временные:
// повтор даст ту же ошибку, поэтому задача падает сразу.
function isRetryableError(err) {
  if (!err) return true;
  if (err.retryable === false) return false;
  if (err.retryable === true) return true;
  const status = Number(err.status || err.statusCode || 0);
  if (status >= 400 && status < 500) return false;
  return true;
}

// Экспоненциальная задержка: attempts — сколько попыток уже сделано (>=1).
function backoffMs(attempts, policy = RETRY_POLICY) {
  const n = Math.max(1, Number(attempts) || 1);
  const delay = policy.baseDelayMs * policy.factor ** (n - 1);
  return Math.min(delay, policy.maxDelayMs);
}

// Что делать со сбойной задачей: повторить (с задержкой) или признать провал.
function retryDecision({ attempts, maxAttempts, error }, policy = RETRY_POLICY) {
  const limit = Number(maxAttempts) || policy.maxAttempts;
  const done = Number(attempts) || 0;
  if (!isRetryableError(error)) {
    return { action: 'fail', delayMs: 0, reason: 'non_retryable' };
  }
  if (done >= limit) {
    return { action: 'fail', delayMs: 0, reason: 'attempts_exhausted' };
  }
  return { action: 'retry', delayMs: backoffMs(done, policy), reason: 'retryable' };
}

// Задача, чей воркер умер (лиза истекла / процесс перезапущен). Попытки ещё есть
// → возвращаем в очередь (работа ПРОДОЛЖИТСЯ с чекпойнта), иначе — interrupted
// (оборвана, а не «упала»: это разные исходы для инженера).
function recoveryDecision({ attempts, maxAttempts }, policy = RETRY_POLICY) {
  const limit = Number(maxAttempts) || policy.maxAttempts;
  const done = Number(attempts) || 0;
  return done < limit
    ? { action: 'requeue', reason: 'lease_expired' }
    : { action: 'interrupt', reason: 'lease_expired_attempts_exhausted' };
}

// Лиза истекла? Времена — ISO-строки в UTC, сравнение лексикографическое.
function isLeaseExpired(task, nowIso) {
  if (!task || task.status !== TASK_STATUS.RUNNING) return false;
  if (!task.lease_expires_at) return true;
  return String(task.lease_expires_at) < String(nowIso);
}

// --- Сведение состояния задания -------------------------------------------------

// Статус задания из статусов его задач. Приоритет исходов: пока есть незавершённые
// — задание живо; дальше отмена (её попросил инженер) > сбой > обрыв > успех.
function deriveJobStatus(tasks, { cancelRequested = false } = {}) {
  const list = Array.isArray(tasks) ? tasks : [];
  if (!list.length) return JOB_STATUS.QUEUED;
  const has = (s) => list.some((t) => t.status === s);
  if (list.some((t) => isPending(t.status))) {
    // «Начато» — не только когда что-то бежит прямо сейчас: задача, ждущая
    // повтора после сбоя (attempts > 0), тоже означает, что задание в работе.
    const started = has(TASK_STATUS.RUNNING)
      || list.some((t) => !isPending(t.status))
      || list.some((t) => Number(t.attempts) > 0);
    return started ? JOB_STATUS.RUNNING : JOB_STATUS.QUEUED;
  }
  if (cancelRequested && has(TASK_STATUS.CANCELLED)) return JOB_STATUS.CANCELLED;
  if (has(TASK_STATUS.FAILED)) return JOB_STATUS.FAILED;
  if (has(TASK_STATUS.CANCELLED)) return JOB_STATUS.CANCELLED;
  if (has(TASK_STATUS.INTERRUPTED)) return JOB_STATUS.INTERRUPTED;
  return JOB_STATUS.COMPLETED;
}

const isTerminalJobStatus = (s) => !ACTIVE_JOB_STATUSES.includes(s);

// Прогресс задания. Если задачи репортят свой прогресс (стадия — по сегментам ТЗ),
// суммируем его; иначе прогресс = сколько задач из скольких пройдено (конвейер).
function rollupProgress(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const reported = list.filter((t) => Number(t.progress_total) > 0);
  if (reported.length) {
    return {
      total: reported.reduce((a, t) => a + Number(t.progress_total || 0), 0),
      done: reported.reduce((a, t) => a + Number(t.progress_done || 0), 0),
    };
  }
  return { total: list.length, done: list.filter((t) => isPassed(t.status)).length };
}

// --- Правила выборки задачи (те же, что в SQL claimTask) ------------------------

// Задача готова к запуску: она в очереди, отложенный старт наступил и
// предшественники по seq завершены (для always_run — просто не выполняются).
function isTaskReady(task, siblings, nowIso) {
  if (!task || task.status !== TASK_STATUS.QUEUED) return false;
  if (task.run_after && String(task.run_after) > String(nowIso)) return false;
  const preds = (siblings || []).filter((s) => s.job_id === task.job_id && Number(s.seq) < Number(task.seq));
  if (task.always_run) return preds.every((p) => !isPending(p.status));
  return preds.every((p) => isPassed(p.status));
}

// Порядок выборки из очереди: приоритет → время готовности → порядок внутри задания.
function compareClaimOrder(a, b) {
  const p = (Number(a.priority) || 0) - (Number(b.priority) || 0);
  if (p) return p;
  const r = String(a.run_after || '').localeCompare(String(b.run_after || ''));
  if (r) return r;
  const s = (Number(a.seq) || 0) - (Number(b.seq) || 0);
  if (s) return s;
  return String(a.id).localeCompare(String(b.id));
}

// Ошибка отмены: воркер увидел cancel_requested и прервал задачу кооперативно.
class JobCancelledError extends Error {
  constructor(message = 'Задание отменено') {
    super(message);
    this.name = 'JobCancelledError';
    this.cancelled = true;
    this.retryable = false;
  }
}

module.exports = {
  JOB_STATUS,
  TASK_STATUS,
  ACTIVE_JOB_STATUSES,
  PENDING_TASK_STATUSES,
  PASSED_TASK_STATUSES,
  RETRY_POLICY,
  SCOPE_PIPELINE,
  stageScopeKey,
  idempotencyKey,
  advisoryLockKey,
  isRetryableError,
  backoffMs,
  retryDecision,
  recoveryDecision,
  isLeaseExpired,
  deriveJobStatus,
  isTerminalJobStatus,
  rollupProgress,
  isTaskReady,
  compareClaimOrder,
  JobCancelledError,
};
