'use strict';

// Тесты слоя сборки: группировка находок по месту ТЗ, выбор primary (по
// критичности), флаг конфликта, вердикт, дедуп для экспорта. Чистые функции —
// без БД. Запуск: npm test.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  groupIssues,
  pickPrimary,
  buildGroup,
  dedupeExportDecisions,
} = require('../services/review/consolidation');

function mk(o) {
  return {
    id: o.id,
    analysis_stage: o.stage ?? 1,
    paragraph_index: o.paragraph_index ?? null,
    char_start: o.char_start ?? null,
    char_end: o.char_end ?? null,
    source_fragment: o.source_fragment ?? 'frag',
    criticality: o.criticality ?? 'medium',
    review_status: o.review_status ?? 'pending',
    decision_kind: o.decision_kind ?? null,
    problem_type: o.problem_type ?? 'x',
  };
}

test('группировка: перекрывающиеся диапазоны в одном абзаце → одна группа', () => {
  const a = mk({ id: 'a', paragraph_index: 2, char_start: 0, char_end: 20, criticality: 'high', stage: 1 });
  const b = mk({ id: 'b', paragraph_index: 2, char_start: 10, char_end: 30, criticality: 'medium', stage: 4 });
  const c = mk({ id: 'c', paragraph_index: 2, char_start: 50, char_end: 60, criticality: 'low', stage: 5 });
  const groups = groupIssues([a, b, c]);
  assert.equal(groups.length, 2); // a&b перекрываются → одна; c — отдельная
  const big = groups.find((g) => g.length === 2);
  assert.deepEqual(big.map((i) => i.id).sort(), ['a', 'b']);
});

test('группировка: одинаковая цитата без якоря → одна группа', () => {
  const d = mk({ id: 'd', paragraph_index: null, source_fragment: 'Гарантия 5 лет', stage: 3, criticality: 'high' });
  const e = mk({ id: 'e', paragraph_index: null, source_fragment: 'гарантия 5 лет', stage: 2, criticality: 'medium' });
  const f = mk({ id: 'f', paragraph_index: null, source_fragment: 'Иное условие', stage: 3 });
  const groups = groupIssues([d, e, f]);
  assert.equal(groups.length, 2);
});

test('primary: по критичности (critical > later stage)', () => {
  const p = pickPrimary([
    mk({ id: 'x', criticality: 'medium', stage: 1, char_start: 0 }),
    mk({ id: 'y', criticality: 'critical', stage: 5, char_start: 5 }),
  ]);
  assert.equal(p.id, 'y');
});

test('primary: тай-брейк по порядку стадий при равной критичности', () => {
  const p = pickPrimary([
    mk({ id: 's5', criticality: 'high', stage: 5, char_start: 0 }),
    mk({ id: 's1', criticality: 'high', stage: 1, char_start: 9 }),
  ]);
  assert.equal(p.id, 's1');
});

test('buildGroup: конфликт (удаление vs примечание) + вердикт от primary', () => {
  const g = buildGroup([
    mk({ id: 'pri', paragraph_index: 1, char_start: 0, char_end: 10, criticality: 'high', stage: 1, decision_kind: 'delete', review_status: 'accepted' }),
    mk({ id: 'rel', paragraph_index: 1, char_start: 0, char_end: 10, criticality: 'medium', stage: 5, decision_kind: 'accept', review_status: 'accepted' }),
  ]);
  assert.equal(g.primary.id, 'pri');
  assert.equal(g.conflict, true);
  assert.equal(g.verdict, 'review_edit');
  assert.equal(g.related.length, 1);
  assert.deepEqual(g.stages, [1, 5]);
  assert.equal(g.multi_stage, true);
});

test('buildGroup: два удаления — без конфликта', () => {
  const g = buildGroup([
    mk({ id: 'a', criticality: 'high', stage: 1, decision_kind: 'delete', review_status: 'accepted' }),
    mk({ id: 'b', criticality: 'medium', stage: 4, decision_kind: 'remove_from_scope', review_status: 'accepted' }),
  ]);
  assert.equal(g.conflict, false);
  assert.equal(g.verdict, 'review_edit');
});

test('buildGroup: pending — вердикт «на рассмотрении»', () => {
  const g = buildGroup([mk({ id: 'a', criticality: 'high', stage: 5, review_status: 'pending' })]);
  assert.equal(g.verdict, 'pending');
  assert.equal(g.pending_count, 1);
});

test('dedupeExportDecisions: на одно место — primary, остальное в дубли', () => {
  const items = [
    { issue: mk({ id: 'a', paragraph_index: 1, char_start: 0, char_end: 10, criticality: 'high', stage: 1 }), decision_kind: 'delete' },
    { issue: mk({ id: 'b', paragraph_index: 1, char_start: 2, char_end: 8, criticality: 'medium', stage: 4 }), decision_kind: 'comment' },
    { issue: mk({ id: 'c', paragraph_index: 9, char_start: 0, char_end: 5, criticality: 'low', stage: 5 }), decision_kind: 'delete' },
  ];
  const { kept, duplicates } = dedupeExportDecisions(items);
  assert.equal(kept.length, 2); // место(1) + место(9)
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].issue.id, 'b');
  assert.ok(kept.some((k) => k.issue.id === 'a'));
  assert.ok(kept.some((k) => k.issue.id === 'c'));
});
