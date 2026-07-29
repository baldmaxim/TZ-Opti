'use strict';

// Юнит-тесты РАСЧЁТА КАЖДОЙ МЕТРИКИ benchmark-контура.
// Без БД, без сети, без LLM: на вход подаются готовые снимки классификации
// (форма evaluator.evaluateDocument), проверяется только арифметика.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  ratio,
  precisionAtK,
  computeDocumentMetrics,
  aggregateMetrics,
} = require('../../../services/benchmark/metrics');

// Пустой снимок классификации; поля переопределяются в каждом тесте.
function snapshot(overrides = {}) {
  return {
    document_id: 'doc',
    published_count: 0,
    unpublished_count: 0,
    expected_total: 0,
    expected_matched: 0,
    expected_critical_total: 0,
    expected_critical_matched: 0,
    true_positives: [],
    duplicates: [],
    informational: [],
    false_positives: [],
    false_negatives: [],
    unsupported: [],
    no_consequence: [],
    ranked_classes: [],
    ...overrides,
  };
}

const stubs = (n) => Array.from({ length: n }, (_, i) => ({ finding_id: `f${i}` }));

test('precision: доля TP среди опубликованных', () => {
  const m = computeDocumentMetrics(snapshot({
    published_count: 6,
    true_positives: stubs(3),
    false_positives: stubs(1),
    duplicates: stubs(1),
    informational: stubs(1),
  }));
  assert.equal(m.precision, 0.5);
});

test('recall: доля закрытых эталонов', () => {
  const m = computeDocumentMetrics(snapshot({ expected_total: 4, expected_matched: 3 }));
  assert.equal(m.recall, 0.75);
});

test('precision@10: только первые 10 находок по рангу', () => {
  // 15 опубликованных: среди первых 10 — шесть tp, дальше ещё два.
  const ranked = [
    'tp', 'tp', 'false_positive', 'tp', 'duplicate',
    'tp', 'informational', 'tp', 'false_positive', 'tp',
    'tp', 'false_positive', 'tp', 'duplicate', 'false_positive',
  ];
  assert.equal(precisionAtK(ranked, 10), 0.6);
});

test('precision@20: находок меньше 20 — знаменатель равен их числу', () => {
  const ranked = [
    'tp', 'tp', 'false_positive', 'tp', 'duplicate',
    'tp', 'informational', 'tp', 'false_positive', 'tp',
    'tp', 'false_positive', 'tp', 'duplicate', 'false_positive',
  ];
  assert.equal(precisionAtK(ranked, 20), ratio(8, 15));
});

test('recall критических рисков: считается только по kind=critical', () => {
  const m = computeDocumentMetrics(snapshot({
    expected_total: 5,
    expected_matched: 4,
    expected_critical_total: 2,
    expected_critical_matched: 1,
  }));
  assert.equal(m.recall_critical, 0.5);
});

test('duplicate rate: доля дублей среди опубликованных', () => {
  const m = computeDocumentMetrics(snapshot({ published_count: 8, duplicates: stubs(2) }));
  assert.equal(m.duplicate_rate, 0.25);
});

test('informational leakage: доля утечек запрещённого', () => {
  const m = computeDocumentMetrics(snapshot({ published_count: 5, informational: stubs(1) }));
  assert.equal(m.informational_leakage, 0.2);
});

test('unsupported rate: доля находок без опоры', () => {
  const m = computeDocumentMetrics(snapshot({ published_count: 4, unsupported: ['a', 'b'] }));
  assert.equal(m.unsupported_rate, 0.5);
});

test('no_consequence_count: абсолютное число находок без последствия', () => {
  const m = computeDocumentMetrics(snapshot({ published_count: 4, no_consequence: ['a', 'b', 'c'] }));
  assert.equal(m.no_consequence_count, 3);
});

test('неопределённые дроби дают null, а не 0', () => {
  const m = computeDocumentMetrics(snapshot());
  assert.equal(m.precision, null);
  assert.equal(m.recall, null);
  assert.equal(m.precision_at_10, null);
  assert.equal(m.precision_at_20, null);
  assert.equal(m.recall_critical, null);
  assert.equal(m.duplicate_rate, null);
  assert.equal(m.informational_leakage, null);
  assert.equal(m.unsupported_rate, null);
  assert.equal(m.no_consequence_count, 0);
});

test('агрегация: счётные метрики микро (по суммам), precision@K макро', () => {
  const docA = snapshot({
    published_count: 4,
    true_positives: stubs(4),
    expected_total: 4,
    expected_matched: 4,
    expected_critical_total: 1,
    expected_critical_matched: 1,
    ranked_classes: ['tp', 'tp', 'tp', 'tp'],
  });
  const docB = snapshot({
    published_count: 4,
    true_positives: stubs(2),
    false_positives: stubs(1),
    duplicates: stubs(1),
    false_negatives: stubs(2),
    expected_total: 4,
    expected_matched: 2,
    expected_critical_total: 1,
    expected_critical_matched: 0,
    unsupported: ['x'],
    no_consequence: ['x', 'y'],
    ranked_classes: ['tp', 'duplicate', 'tp', 'false_positive'],
  });
  const { counts, metrics } = aggregateMetrics([docA, docB]);
  assert.equal(counts.published, 8);
  assert.equal(counts.true_positives, 6);
  assert.equal(counts.false_negatives, 2);
  assert.equal(metrics.precision, 0.75); // микро: 6/8
  assert.equal(metrics.recall, 0.75); // микро: 6/8
  assert.equal(metrics.recall_critical, 0.5); // микро: 1/2
  assert.equal(metrics.precision_at_10, 0.75); // макро: (1 + 0.5) / 2
  assert.equal(metrics.duplicate_rate, ratio(1, 8));
  assert.equal(metrics.informational_leakage, 0); // 0 утечек при 8 опубликованных
  assert.equal(metrics.unsupported_rate, ratio(1, 8));
  assert.equal(metrics.no_consequence_count, 2);
});

test('нулевой числитель при ненулевом знаменателе — это 0, а не null', () => {
  const m = computeDocumentMetrics(snapshot({ published_count: 3, false_positives: stubs(3), ranked_classes: ['false_positive', 'false_positive', 'false_positive'] }));
  assert.equal(m.precision, 0);
  assert.equal(m.duplicate_rate, 0);
  assert.equal(m.informational_leakage, 0);
  assert.equal(m.unsupported_rate, 0);
  assert.equal(m.precision_at_10, 0);
});
