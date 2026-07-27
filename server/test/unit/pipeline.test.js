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
  runPipeline,
  runPipelineStep,
} = require('../../services/pipeline/analysisPipeline');
const { STATUS, severityOf } = require('../../services/analysis/resultStatus');

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

test('summarizeRun: все шаги done -> ok + status completed', () => {
  const s = summarizeRun([
    { step: 'draft_issues', status: 'done' },
    { step: 'critic', status: 'done' },
  ]);
  assert.equal(s.ok, true);
  assert.equal(s.status, STATUS.COMPLETED);
  assert.equal(severityOf(s.status), 'success');
  assert.equal(s.steps_done, 2);
  assert.equal(s.steps_total, 2);
  assert.equal(s.failed_step, null);
});

test('summarizeRun: сбой шага -> ok=false, status failed, назван первый сбойный шаг', () => {
  const s = summarizeRun([
    { step: 'draft_issues', status: 'done' },
    { step: 'critic', status: 'failed' },
    { step: 'clustering', status: 'skipped' },
  ]);
  assert.equal(s.ok, false);
  assert.equal(s.status, STATUS.FAILED);
  assert.equal(severityOf(s.status), 'error');
  assert.equal(s.steps_done, 1);
  assert.equal(s.steps_total, 3);
  assert.equal(s.failed_step, 'critic');
});

test('summarizeRun: пустой прогон не считается успешным -> status failed', () => {
  const s = summarizeRun([]);
  assert.equal(s.ok, false);
  assert.equal(s.status, STATUS.FAILED);
});

// Частичный результат шага (self-analysis: часть ТЗ не досчитана) — не сбой, но и
// не полный успех: status=completed_with_warnings (severity=warning), ok остаётся
// true (итог пригоден). Портал НЕ показывает зелёный полный успех (п.4 аудита).
test('summarizeRun: шаг done+warnings -> completed_with_warnings, ok=true, но не success', () => {
  const s = summarizeRun([
    { step: 'draft_issues', status: 'done' },
    { step: 'clustering', status: 'done' },
    { step: 'self_analysis', status: 'done', warnings: true, warnings_reason: 'не досчитано частей ТЗ: 2' },
  ]);
  assert.equal(s.ok, true);
  assert.equal(s.status, STATUS.COMPLETED_WITH_WARNINGS);
  assert.equal(severityOf(s.status), 'warning');
  assert.equal(s.failed_step, null);
  assert.ok(Array.isArray(s.warnings) && s.warnings.length === 1);
  assert.equal(s.warnings[0].step, 'self_analysis');
});

test('summarizeRun: сбой шага важнее warnings — status failed', () => {
  const s = summarizeRun([
    { step: 'draft_issues', status: 'done', warnings: true },
    { step: 'critic', status: 'failed' },
  ]);
  assert.equal(s.ok, false);
  assert.equal(s.status, STATUS.FAILED);
});

// --- runPipelineStep: частичный summary шага -> warnings ------------------------

test('runPipelineStep: summary.partial помечает шаг warnings (не роняя его в failed)', async () => {
  const runners = {
    self_analysis: async () => ({ summary: { findings: 3, partial: true, failed_parts: [{ part: 2 }, { part: 4 }] } }),
  };
  const step = await runPipelineStep('t-1', 'run-1', 'self_analysis', runners);
  assert.equal(step.status, 'done');
  assert.equal(step.warnings, true);
  assert.match(step.warnings_reason, /2/);
});

test('runPipelineStep: полный summary шага -> без warnings', async () => {
  const runners = {
    clustering: async () => ({ summary: { clusters: 5, partial: false } }),
  };
  const step = await runPipelineStep('t-1', 'run-1', 'clustering', runners);
  assert.equal(step.status, 'done');
  assert.ok(!step.warnings);
});

// --- runPipeline: оркестрация с инъекцией раннеров + реестра прогонов (без БД) --

// Заглушка реестра прогонов: без БД. Пишет вызовы жизненного цикла для проверок.
function fakeRuns() {
  const lc = { begin: 0, activate: 0, fail: 0 };
  return {
    SCOPE_PIPELINE: 'pipeline',
    currentDocumentsRevision: async () => 'docs_x',
    currentConfigVersion: () => 'cfg_x',
    beginRun: async () => { lc.begin += 1; return 'run_x'; },
    activateRun: async () => { lc.activate += 1; },
    failRun: async () => { lc.fail += 1; },
    _lc: lc,
  };
}

test('runPipeline: сбой шага конвейера -> {ok:false}, failRun, прогон НЕ активируется', async () => {
  const calls = [];
  const runners = {
    draft_issues: async (id, runId) => { calls.push(['draft_issues', id, runId]); return { summary: { count: 3 } }; },
    critic: async () => { calls.push(['critic']); throw new Error('LLM недоступен'); },
    clustering: async () => { calls.push(['clustering']); return { summary: {} }; },
    self_analysis: async () => { calls.push(['self_analysis']); return { summary: {} }; },
  };
  const runs = fakeRuns();
  const report = await runPipeline('t-1', { withSelfAnalysis: false }, runners, runs);

  assert.equal(report.ok, false);
  assert.equal(report.status, STATUS.FAILED);
  assert.equal(report.failed_step, 'critic');
  assert.equal(report.run_id, 'run_x');
  const byStep = Object.fromEntries(report.steps.map((s) => [s.step, s.status]));
  assert.equal(byStep.draft_issues, 'done');
  assert.equal(byStep.critic, 'failed');
  assert.equal(byStep.clustering, 'skipped', 'шаг после сбоя не должен выполняться');
  assert.ok(!calls.some((c) => c[0] === 'clustering'), 'раннер после сбоя не вызывается');
  // runId прокинут в раннер; при сбое — failRun, БЕЗ активации (указатель не двигаем).
  assert.equal(calls[0][2], 'run_x', 'runId прокинут в раннер');
  assert.equal(runs._lc.begin, 1);
  assert.equal(runs._lc.activate, 0);
  assert.equal(runs._lc.fail, 1);
});

test('runPipeline: все шаги done -> {ok:true}, прогон активируется', async () => {
  const runners = {
    draft_issues: async () => ({ summary: { count: 2 } }),
    critic: async () => ({ summary: {} }),
    clustering: async () => ({ summary: { clusters: 1 } }),
    self_analysis: async () => ({ summary: {} }),
  };
  const runs = fakeRuns();
  const report = await runPipeline('t-2', { withSelfAnalysis: false }, runners, runs);
  assert.equal(report.ok, true);
  assert.equal(report.status, STATUS.COMPLETED);
  assert.equal(report.failed_step, null);
  assert.equal(report.steps.length, 3); // self_analysis выключен
  assert.equal(runs._lc.begin, 1);
  assert.equal(runs._lc.activate, 1, 'по успеху прогон активируется');
  assert.equal(runs._lc.fail, 0);
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
