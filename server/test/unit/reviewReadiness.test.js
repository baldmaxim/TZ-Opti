'use strict';

// Готовность рецензии (review/reviewReadinessService.computeReadiness) — чистое
// ядро жёсткого гейта выгрузок: что считается завершённой рецензией и что её
// блокирует. Запуск: npm run test:unit.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { computeReadiness } = require('../../services/review/reviewReadinessService');

const cluster = (id, show = 1) => ({ id, show_to_engineer: show });
const dec = (pairs) => new Map(pairs.map(([id, decision]) => [id, { decision }]));

const BASE = {
  pipelineRunId: 'run-1',
  documentRevisionId: 'docs_a',
  currentRevisionId: 'docs_a',
};

test('пример контракта: все решены (в т.ч. все reject) → export_allowed', () => {
  const clusters = Array.from({ length: 48 }, (_, i) => cluster(`c${i}`));
  const r = computeReadiness({
    ...BASE,
    clusters,
    decisions: dec(clusters.map((c) => [c.id, 'reject'])),
  });
  assert.equal(r.total_clusters, 48);
  assert.equal(r.decided_clusters, 48);
  assert.equal(r.rejected_clusters, 48);
  assert.equal(r.accepted_clusters, 0);
  assert.equal(r.unresolved_clusters, 0);
  assert.equal(r.carryovers_pending, 0);
  assert.equal(r.pipeline_stale, false);
  assert.equal(r.export_allowed, true);
  assert.equal(r.reasons, null);
});

test('нерешённый кластер рабочего списка блокирует экспорт', () => {
  const r = computeReadiness({
    ...BASE,
    clusters: [cluster('a'), cluster('b')],
    decisions: dec([['a', 'accept']]),
  });
  assert.equal(r.unresolved_clusters, 1);
  assert.equal(r.accepted_clusters, 1);
  assert.equal(r.export_allowed, false);
  assert.match(r.reasons.join(' '), /без решения 1 из 2/);
});

test('скрытые кластеры (show_to_engineer=0) решения не требуют', () => {
  const r = computeReadiness({
    ...BASE,
    clusters: [cluster('a'), cluster('hidden', 0)],
    decisions: dec([['a', 'accept']]),
  });
  assert.equal(r.total_clusters, 1);
  assert.equal(r.export_allowed, true);
});

test('неразобранный carry-over блокирует экспорт', () => {
  const r = computeReadiness({
    ...BASE,
    clusters: [cluster('a')],
    decisions: dec([['a', 'accept']]),
    carryoversPending: 3,
  });
  assert.equal(r.carryovers_pending, 3);
  assert.equal(r.export_allowed, false);
  assert.match(r.reasons.join(' '), /перенос решений/);
});

test('устаревший снимок (документы менялись после сборки) блокирует экспорт', () => {
  const r = computeReadiness({
    ...BASE,
    currentRevisionId: 'docs_b',
    clusters: [cluster('a')],
    decisions: dec([['a', 'accept']]),
  });
  assert.equal(r.pipeline_stale, true);
  assert.equal(r.export_allowed, false);
});

test('нет активного снимка конвейера — экспортировать нечего', () => {
  const r = computeReadiness({ pipelineRunId: null });
  assert.equal(r.export_allowed, false);
  assert.match(r.reasons.join(' '), /итог анализа не собран/);
});

test('пустой рабочий список при собранном снимке — завершённая рецензия', () => {
  // Все замечания подавлены критиком / находок нет: решать нечего, итог валиден.
  const r = computeReadiness({ ...BASE, clusters: [cluster('h', 0)], decisions: new Map() });
  assert.equal(r.total_clusters, 0);
  assert.equal(r.export_allowed, true);
});
