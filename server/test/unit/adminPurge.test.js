'use strict';

// Чистое ядро admin-purge (services/admin/purgeService.selectRunsToPurge) — без БД.
// Purge — ЕДИНСТВЕННОЕ место физического удаления истории анализа, поэтому его
// правила отбора проверяются отдельно: что нельзя удалять ни при каких опциях.
// Запуск: npm run test:unit.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { selectRunsToPurge } = require('../../services/admin/purgeService');

const run = (id, over = {}) => ({
  id,
  kind: 'pipeline',
  stage: null,
  status: 'completed',
  superseded_at: '2026-07-01T00:00:00.000Z',
  started_at: '2026-07-01T00:00:00.000Z',
  ...over,
});

test('актуальный (по указателю) прогон не удаляется ни при каких опциях', () => {
  const runs = [run('active'), run('old', { started_at: '2026-06-01T00:00:00.000Z' })];
  const { purge, keep } = selectRunsToPurge(runs, new Set(['active']), { keepLast: 0 });
  assert.deepEqual(purge.map((r) => r.id), ['old']);
  assert.ok(keep.includes('active'));
});

test('выполняющийся прогон (running) не удаляется — в него сейчас пишут', () => {
  const runs = [run('candidate', { status: 'running', superseded_at: null })];
  const { purge, keep } = selectRunsToPurge(runs, new Set(), { keepLast: 0 });
  assert.deepEqual(purge, []);
  assert.deepEqual(keep, ['candidate']);
});

test('keepLast сохраняет N самых свежих архивов на группу (kind+stage)', () => {
  const runs = [
    run('p3', { started_at: '2026-07-03T00:00:00.000Z' }),
    run('p2', { started_at: '2026-07-02T00:00:00.000Z' }),
    run('p1', { started_at: '2026-07-01T00:00:00.000Z' }),
    run('s1_b', { kind: 'stage', stage: 1, started_at: '2026-07-02T00:00:00.000Z' }),
    run('s1_a', { kind: 'stage', stage: 1, started_at: '2026-07-01T00:00:00.000Z' }),
  ];
  const { purge } = selectRunsToPurge(runs, new Set(), { keepLast: 1 });
  // По одному самому свежему на группу сохраняется: p3 и s1_b.
  assert.deepEqual(purge.map((r) => r.id).sort(), ['p1', 'p2', 's1_a']);
});

test('failed-прогоны тоже подлежат удалению (это мусор, а не история результата)', () => {
  const runs = [
    run('active', { superseded_at: null }),
    run('failed', { status: 'failed', superseded_at: null, started_at: '2026-06-01T00:00:00.000Z' }),
  ];
  const { purge } = selectRunsToPurge(runs, new Set(['active']), { keepLast: 0 });
  assert.deepEqual(purge.map((r) => r.id), ['failed']);
});

test('olderThan: свежее границы не удаляется', () => {
  const runs = [
    run('old', { started_at: '2026-01-01T00:00:00.000Z' }),
    run('recent', { started_at: '2026-07-20T00:00:00.000Z' }),
  ];
  const { purge } = selectRunsToPurge(runs, new Set(), { keepLast: 0, olderThan: '2026-07-01T00:00:00.000Z' });
  assert.deepEqual(purge.map((r) => r.id), ['old']);
});

test('порядок детерминирован при совпадении времени (тай-брейк по id)', () => {
  const same = '2026-07-01T00:00:00.000Z';
  const a = selectRunsToPurge([run('aaa', { started_at: same }), run('bbb', { started_at: same })], new Set(), { keepLast: 1 });
  const b = selectRunsToPurge([run('bbb', { started_at: same }), run('aaa', { started_at: same })], new Set(), { keepLast: 1 });
  assert.deepEqual(a.purge.map((r) => r.id), b.purge.map((r) => r.id));
});

test('пустой вход и мусорные строки не ломают отбор', () => {
  assert.deepEqual(selectRunsToPurge().purge, []);
  assert.deepEqual(selectRunsToPurge([null, {}, { id: '' }], new Set(), { keepLast: 0 }).purge, []);
});
