'use strict';

// Юнит-тесты чистого ядра очереди (services/jobs/jobModel) — без БД и сети.
// Здесь живут ПРАВИЛА, которые обязаны совпадать у SQL (jobQueue) и у фейкового
// стора: ключ идемпотентности, ключ advisory-lock, политика повторов,
// восстановление после истёкшей аренды, свод статуса задания, готовность задачи.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const M = require('../../services/jobs/jobModel');

// --- Ключ идемпотентности --------------------------------------------------------

test('idempotencyKey: один и тот же прогон → один ключ (повторный запуск дублем не станет)', () => {
  const a = M.idempotencyKey({ tenderId: 't1', jobType: 'stage_analysis', scopeKey: 'stage:1', documentsRevisionId: 'docs_x', configVersion: 'cfg_1' });
  const b = M.idempotencyKey({ tenderId: 't1', jobType: 'stage_analysis', scopeKey: 'stage:1', documentsRevisionId: 'docs_x', configVersion: 'cfg_1' });
  assert.equal(a, b);
});

test('idempotencyKey: другая стадия / ревизия / конфигурация → другой ключ', () => {
  const base = { tenderId: 't1', jobType: 'stage_analysis', scopeKey: 'stage:1', documentsRevisionId: 'docs_x', configVersion: 'cfg_1' };
  const key = M.idempotencyKey(base);
  assert.notEqual(key, M.idempotencyKey({ ...base, scopeKey: 'stage:2' }));
  assert.notEqual(key, M.idempotencyKey({ ...base, documentsRevisionId: 'docs_y' }));
  assert.notEqual(key, M.idempotencyKey({ ...base, configVersion: 'cfg_2' }));
  assert.notEqual(key, M.idempotencyKey({ ...base, tenderId: 't2' }));
});

// --- Ключ advisory-lock -----------------------------------------------------------

test('advisoryLockKey: детерминирован и влезает в bigint (знаковые 64 бита)', () => {
  const k = M.advisoryLockKey('t1', 'stage:1', 'docs_x');
  assert.equal(k, M.advisoryLockKey('t1', 'stage:1', 'docs_x'));
  const n = BigInt(k);
  assert.ok(n >= -(2n ** 63n) && n <= 2n ** 63n - 1n, 'ключ должен быть знаковым 64-битным');
});

test('advisoryLockKey: стадия+ревизия входят в ключ (разные прогоны не блокируют друг друга зря)', () => {
  const k = M.advisoryLockKey('t1', 'stage:1', 'docs_x');
  assert.notEqual(k, M.advisoryLockKey('t1', 'stage:2', 'docs_x'));
  assert.notEqual(k, M.advisoryLockKey('t1', 'stage:1', 'docs_y'));
  assert.notEqual(k, M.advisoryLockKey('t2', 'stage:1', 'docs_x'));
});

// --- Политика повторов --------------------------------------------------------------

test('retryDecision: временный сбой при остатке попыток → повтор с растущей задержкой', () => {
  const first = M.retryDecision({ attempts: 1, maxAttempts: 3, error: new Error('LLM 502') });
  const second = M.retryDecision({ attempts: 2, maxAttempts: 3, error: new Error('LLM 502') });
  assert.equal(first.action, 'retry');
  assert.equal(second.action, 'retry');
  assert.ok(second.delayMs > first.delayMs, 'задержка должна расти (экспоненциальный backoff)');
});

test('retryDecision: попытки исчерпаны → провал', () => {
  const d = M.retryDecision({ attempts: 3, maxAttempts: 3, error: new Error('LLM 502') });
  assert.equal(d.action, 'fail');
  assert.equal(d.reason, 'attempts_exhausted');
});

test('retryDecision: 4xx (гейт стадии, нет Q&A) — не временная ошибка, повтор бессмыслен', () => {
  const err = Object.assign(new Error('Стадия 2 недоступна'), { status: 400 });
  const d = M.retryDecision({ attempts: 1, maxAttempts: 3, error: err });
  assert.equal(d.action, 'fail');
  assert.equal(d.reason, 'non_retryable');
});

test('retryDecision: 5xx повторяем, явный retryable=false — нет', () => {
  assert.equal(M.retryDecision({ attempts: 1, maxAttempts: 3, error: Object.assign(new Error('x'), { status: 502 }) }).action, 'retry');
  assert.equal(M.retryDecision({ attempts: 1, maxAttempts: 3, error: Object.assign(new Error('x'), { retryable: false }) }).action, 'fail');
});

test('backoffMs: ограничен максимумом', () => {
  assert.equal(M.backoffMs(99), M.RETRY_POLICY.maxDelayMs);
});

// --- Восстановление после падения/рестарта --------------------------------------------

test('recoveryDecision: остались попытки → задача возвращается в очередь (работа продолжится)', () => {
  assert.deepEqual(M.recoveryDecision({ attempts: 1, maxAttempts: 3 }).action, 'requeue');
});

test('recoveryDecision: попытки исчерпаны → interrupted (оборвана, а не «упала»)', () => {
  assert.deepEqual(M.recoveryDecision({ attempts: 3, maxAttempts: 3 }).action, 'interrupt');
});

test('isLeaseExpired: живая аренда — нет, просроченная и пустая — да', () => {
  const now = '2026-07-01T10:00:00.000Z';
  assert.equal(M.isLeaseExpired({ status: 'running', lease_expires_at: '2026-07-01T10:00:30.000Z' }, now), false);
  assert.equal(M.isLeaseExpired({ status: 'running', lease_expires_at: '2026-07-01T09:59:30.000Z' }, now), true);
  assert.equal(M.isLeaseExpired({ status: 'running', lease_expires_at: null }, now), true);
  // Не running — не наше дело.
  assert.equal(M.isLeaseExpired({ status: 'completed', lease_expires_at: '2026-01-01T00:00:00.000Z' }, now), false);
});

// --- Свод статуса задания ------------------------------------------------------------

const T = (status, extra = {}) => ({ status, job_id: 'j', seq: 0, ...extra });

test('deriveJobStatus: все задачи завершены успешно → completed', () => {
  assert.equal(M.deriveJobStatus([T('completed'), T('completed')]), 'completed');
  assert.equal(M.deriveJobStatus([T('completed'), T('skipped')]), 'completed');
});

test('deriveJobStatus: есть незавершённые → queued/running', () => {
  assert.equal(M.deriveJobStatus([T('queued'), T('queued')]), 'queued');
  assert.equal(M.deriveJobStatus([T('running'), T('queued')]), 'running');
  assert.equal(M.deriveJobStatus([T('completed'), T('queued')]), 'running');
});

test('deriveJobStatus: сбой шага → failed; обрыв → interrupted; отмена → cancelled', () => {
  assert.equal(M.deriveJobStatus([T('completed'), T('failed'), T('skipped')]), 'failed');
  assert.equal(M.deriveJobStatus([T('completed'), T('interrupted')]), 'interrupted');
  assert.equal(M.deriveJobStatus([T('cancelled'), T('skipped')], { cancelRequested: true }), 'cancelled');
});

test('deriveJobStatus: задание без задач ещё не начиналось → queued', () => {
  assert.equal(M.deriveJobStatus([]), 'queued');
});

// --- Прогресс -------------------------------------------------------------------------

test('rollupProgress: задачи репортят сегменты → суммируем их', () => {
  const p = M.rollupProgress([
    { status: 'running', progress_total: 20, progress_done: 7 },
    { status: 'queued', progress_total: 0, progress_done: 0 },
  ]);
  assert.deepEqual(p, { total: 20, done: 7 });
});

test('rollupProgress: без своего прогресса — считаем задачи (шаги конвейера)', () => {
  const p = M.rollupProgress([T('completed'), T('skipped'), T('queued'), T('running')]);
  assert.deepEqual(p, { total: 4, done: 2 });
});

// --- Готовность задачи и порядок выборки ------------------------------------------------

test('isTaskReady: задача ждёт предшественников по seq', () => {
  const now = '2026-07-01T10:00:00.000Z';
  const a = { id: 'a', job_id: 'j', seq: 0, status: 'running', run_after: now };
  const b = { id: 'b', job_id: 'j', seq: 1, status: 'queued', run_after: now };
  assert.equal(M.isTaskReady(b, [a, b], now), false);
  a.status = 'completed';
  assert.equal(M.isTaskReady(b, [a, b], now), true);
});

test('isTaskReady: после сбоя предшественника обычная задача не стартует, always_run — стартует', () => {
  const now = '2026-07-01T10:00:00.000Z';
  const failed = { id: 'a', job_id: 'j', seq: 0, status: 'failed', run_after: now };
  const normal = { id: 'b', job_id: 'j', seq: 1, status: 'queued', run_after: now };
  const finalizer = { id: 'c', job_id: 'j', seq: 2, status: 'queued', run_after: now, always_run: 1 };
  // Шаг после сбойного не запускается…
  assert.equal(M.isTaskReady(normal, [failed, normal, finalizer], now), false);
  // …а финализатор ждёт, пока не останется незавершённых (skipDownstream пометит
  // пропущенные шаги 'skipped'), и после этого обязан отработать.
  assert.equal(M.isTaskReady(finalizer, [failed, normal, finalizer], now), false);
  normal.status = 'skipped';
  assert.equal(M.isTaskReady(finalizer, [failed, normal, finalizer], now), true);
});

test('isTaskReady: отложенный повтор (run_after в будущем) ещё не готов', () => {
  const now = '2026-07-01T10:00:00.000Z';
  const t = { id: 'a', job_id: 'j', seq: 0, status: 'queued', run_after: '2026-07-01T10:00:05.000Z' };
  assert.equal(M.isTaskReady(t, [t], now), false);
  assert.equal(M.isTaskReady(t, [t], '2026-07-01T10:00:06.000Z'), true);
});

test('compareClaimOrder: приоритет → время готовности → порядок внутри задания', () => {
  const rows = [
    { id: '3', priority: 100, run_after: '2026-07-01T10:00:02.000Z', seq: 0 },
    { id: '1', priority: 10, run_after: '2026-07-01T10:00:05.000Z', seq: 0 },
    { id: '2', priority: 100, run_after: '2026-07-01T10:00:01.000Z', seq: 1 },
  ];
  assert.deepEqual(rows.sort(M.compareClaimOrder).map((r) => r.id), ['1', '2', '3']);
});
