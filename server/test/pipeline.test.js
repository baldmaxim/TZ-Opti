'use strict';

// Юнит-тесты оркестратора конвейера (pipeline/analysisPipeline.js) — без БД и LLM.
// Проверяют чистое ядро: состав шагов прогона (planSteps), свёртку отчёта
// (summarizeRun) и вычисление свежести слоёв (computeLayerStatus). Запуск: npm test.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  PIPELINE_STEPS,
  planSteps,
  summarizeRun,
  computeLayerStatus,
} = require('../services/pipeline/analysisPipeline');

// --- planSteps ----------------------------------------------------------------

test('planSteps: по умолчанию все шаги в порядке зависимости', () => {
  assert.deepEqual(planSteps(), ['draft_issues', 'critic', 'clustering', 'self_analysis']);
});

test('planSteps: withSelfAnalysis=false исключает только опциональный QC-шаг', () => {
  assert.deepEqual(planSteps({ withSelfAnalysis: false }), ['draft_issues', 'critic', 'clustering']);
  // прочие шаги не помечены опциональными — выключить их нельзя
  assert.equal(PIPELINE_STEPS.filter((s) => s.optional).length, 1);
});

// --- summarizeRun ---------------------------------------------------------------

test('summarizeRun: все шаги done -> ok', () => {
  const s = summarizeRun([
    { step: 'draft_issues', status: 'done' },
    { step: 'critic', status: 'done' },
  ]);
  assert.equal(s.ok, true);
  assert.equal(s.steps_done, 2);
  assert.equal(s.steps_total, 2);
  assert.equal(s.failed_step, null);
});

test('summarizeRun: сбой шага -> ok=false, назван первый сбойный шаг', () => {
  const s = summarizeRun([
    { step: 'draft_issues', status: 'done' },
    { step: 'critic', status: 'failed' },
    { step: 'clustering', status: 'skipped' },
  ]);
  assert.equal(s.ok, false);
  assert.equal(s.steps_done, 1);
  assert.equal(s.steps_total, 3);
  assert.equal(s.failed_step, 'critic');
});

test('summarizeRun: пустой прогон не считается успешным', () => {
  assert.equal(summarizeRun([]).ok, false);
});

// --- computeLayerStatus ---------------------------------------------------------

function layer(key, count, builtAt) {
  return { key, count, built_at: builtAt };
}

test('computeLayerStatus: свежая цепочка (каждый слой не раньше родителя) -> без stale', () => {
  const out = computeLayerStatus([
    layer('signals', 10, '2026-06-10T10:00:00.000Z'),
    layer('draft_issues', 5, '2026-06-10T10:01:00.000Z'),
    layer('critic', 5, '2026-06-10T10:01:00.000Z'), // одно время с родителем — не stale
    layer('clustering', 3, '2026-06-10T10:02:00.000Z'),
  ]);
  assert.ok(out.every((l) => !l.stale));
});

test('computeLayerStatus: родитель пересобран позже -> ребёнок stale', () => {
  const out = computeLayerStatus([
    layer('signals', 10, '2026-06-10T12:00:00.000Z'), // стадии перегнали заново
    layer('draft_issues', 5, '2026-06-10T10:01:00.000Z'),
  ]);
  assert.equal(out[0].stale, false);
  assert.equal(out[1].stale, true);
});

test('computeLayerStatus: слой пуст при непустом родителе -> stale (не собран/каскад почистил)', () => {
  const out = computeLayerStatus([
    layer('draft_issues', 5, '2026-06-10T10:00:00.000Z'),
    layer('critic', 0, null),
  ]);
  assert.equal(out[1].stale, true);
  assert.equal(out[1].empty, true);
});

test('computeLayerStatus: слой не пуст при пустом родителе -> stale (сирота)', () => {
  const out = computeLayerStatus([
    layer('draft_issues', 0, null),
    layer('critic', 4, '2026-06-10T10:00:00.000Z'),
  ]);
  assert.equal(out[1].stale, true);
});

test('computeLayerStatus: вся цепочка пустая -> empty, но не stale', () => {
  const out = computeLayerStatus([
    layer('signals', 0, null),
    layer('draft_issues', 0, null),
    layer('critic', 0, null),
  ]);
  assert.ok(out.every((l) => l.empty && !l.stale));
});

test('computeLayerStatus: count-строки из Postgres приводятся к числу', () => {
  const out = computeLayerStatus([
    layer('signals', '10', '2026-06-10T10:00:00.000Z'),
    layer('draft_issues', '0', null),
  ]);
  assert.equal(out[0].count, 10);
  assert.equal(out[0].empty, false);
  assert.equal(out[1].stale, true); // '0' — это пусто при непустом родителе
});
