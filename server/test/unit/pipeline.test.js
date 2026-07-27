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
  beginPipelineRun,
  MODE,
  resolveMode,
} = require('../../services/pipeline/analysisPipeline');
const { VIOLATION, buildInputsManifest, verifyInputsManifest } = require('../../services/pipeline/pipelineManifest');
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

// Страж ложного успеха: шаг вернул summary, но контракт в нём — failed
// (self-analysis: QC не досчитал НИ ОДНУ часть ТЗ). Шаг обязан упасть, а не
// пройти как done с непригодным результатом.
test('runPipelineStep: summary.status=failed роняет шаг (а не проходит как done)', async () => {
  const runners = {
    self_analysis: async () => ({
      summary: {
        findings: 4, status: STATUS.FAILED, llm_status: 'failed',
        llm_reason: 'не досчитана ни одна часть ТЗ (3) — LLM недоступен',
      },
    }),
  };
  await assert.rejects(
    () => runPipelineStep('t-1', 'run-1', 'self_analysis', runners),
    /не досчитана ни одна часть/,
  );
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

// Полный набор входов: все стадии 1–4 completed по одной ревизии, указатель —
// на самом свежем прогоне каждой стадии.
function healthyStageInputs(revision = 'docs_x') {
  return [1, 2, 3, 4].map((stage) => ({
    stage,
    active_run_id: `run_s${stage}`,
    latest_run_id: `run_s${stage}`,
    run: {
      id: `run_s${stage}`,
      stage,
      status: 'completed',
      documents_revision_id: revision,
      config_version: 'cfg_x',
      superseded_at: null,
    },
  }));
}

// Заглушка реестра прогонов: без БД. Пишет вызовы жизненного цикла для проверок.
// stageInputs — функция: возвращает состояние входов на МОМЕНТ вызова (так тест
// имитирует сдвиг указателя стадии во время сборки).
function fakeRuns({ stageInputs = () => healthyStageInputs(), documentsRevision = () => 'docs_x' } = {}) {
  const lc = { begin: 0, activate: 0, fail: 0, completeNoActivate: 0 };
  let manifest = null;
  return {
    SCOPE_PIPELINE: 'pipeline',
    currentDocumentsRevision: async () => documentsRevision(),
    currentConfigVersion: () => 'cfg_x',
    collectStageInputs: async (_t, stages = [1, 2, 3, 4]) => {
      const all = stageInputs();
      return stages.map((s) => all.find((i) => Number(i.stage) === Number(s)) || { stage: Number(s) });
    },
    beginRun: async (_t, _scope, opts = {}) => {
      lc.begin += 1;
      manifest = opts.inputsManifest || null;
      return 'run_x';
    },
    getRunInputsManifest: async () => manifest,
    activateRun: async () => { lc.activate += 1; },
    completeRunWithoutActivation: async () => { lc.completeNoActivate += 1; },
    failRun: async () => { lc.fail += 1; },
    _lc: lc,
    get _manifest() { return manifest; },
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
  assert.equal(report.activated, true);
  assert.equal(report.mode, MODE.PRODUCTION);
  assert.equal(report.inputs.ok, true);
});

// --- Атомарность: manifest входов + отсутствие активации stale-снимка -----------
//
// Конвейер собирается из ТОЧНОГО набора stage-прогонов, зафиксированного на старте
// (стадия + run_id + ревизия документов + версия конфигурации + статус). Проверок
// две: до шагов (набор годен) и перед активацией (набор не изменился).

test('manifest фиксирует пять полей на каждую обязательную стадию', async () => {
  const runs = fakeRuns();
  const { manifest } = await beginPipelineRun('t-m', runs);
  assert.deepEqual(manifest.required_stages, [1, 2, 3, 4]);
  assert.equal(manifest.mode, MODE.PRODUCTION);
  assert.equal(manifest.documents_revision_id, 'docs_x');
  assert.equal(manifest.config_version, 'cfg_x');
  for (const s of manifest.stages) {
    assert.equal(typeof s.stage, 'number');
    assert.equal(s.analysis_run_id, `run_s${s.stage}`);
    assert.equal(s.documents_revision_id, 'docs_x');
    assert.equal(s.config_version, 'cfg_x');
    assert.equal(s.status, 'completed');
  }
  // Manifest сохранён В СТРОКЕ ПРОГОНА: финализатор может исполняться в другом
  // процессе (сборка идёт задачами очереди) и обязан судить по тому же набору.
  assert.deepEqual(await runs.getRunInputsManifest('run_x'), manifest);
});

// Главный сценарий задачи: стадию 3 перезапустили, новый прогон УПАЛ, а указатель
// остался на прежнем успешном снимке. Собирать итог из него нельзя.
test('повторный анализ упал, но есть СТАРЫЙ активный результат стадии → сборка не запускается', async () => {
  const stageInputs = () => {
    const inputs = healthyStageInputs();
    const s3 = inputs.find((i) => i.stage === 3);
    s3.latest_run_id = 'run_s3_retry'; // новый прогон стадии 3 …
    s3.latest_status = 'failed'; // … не стал актуальным (упал)
    return inputs;
  };
  const runners = { draft_issues: async () => { throw new Error('шаг не должен вызываться'); } };
  const runs = fakeRuns({ stageInputs });

  const report = await runPipeline('t-stale-stage', { withSelfAnalysis: false }, runners, runs);

  assert.equal(report.ok, false);
  assert.equal(report.status, STATUS.FAILED);
  assert.equal(report.blocked, 'inputs');
  assert.equal(report.run_id, null, 'прогон даже не начинали');
  assert.equal(runs._lc.begin, 0);
  assert.equal(runs._lc.activate, 0, 'указатель конвейера не двигается');
  const codes = report.inputs.violations.map((v) => v.code);
  assert.ok(codes.includes(VIOLATION.STAGE_POINTER_STALE), `ожидался stage_pointer_stale, получено ${codes}`);
  assert.ok(report.steps.every((s) => s.status === 'skipped'), 'ни один шаг не выполняется');
  assert.match(report.error, /стадия 3|Стадия 3/i);
});

test('неуспешная стадия (failed/cancelled/interrupted/running) блокирует production-сборку', async () => {
  for (const status of ['failed', 'cancelled', 'interrupted', 'running']) {
    const stageInputs = () => {
      const inputs = healthyStageInputs();
      inputs.find((i) => i.stage === 2).run.status = status;
      return inputs;
    };
    const runs = fakeRuns({ stageInputs });
    // eslint-disable-next-line no-await-in-loop
    const report = await runPipeline('t-bad', { withSelfAnalysis: false }, {}, runs);
    assert.equal(report.blocked, 'inputs', `статус «${status}» обязан блокировать сборку`);
    assert.ok(report.inputs.violations.some((v) => v.code === VIOLATION.STAGE_RUN_NOT_COMPLETED));
    assert.equal(runs._lc.activate, 0);
  }
});

test('нет снимка обязательной стадии → сборка не запускается (STAGE_RUN_MISSING)', async () => {
  const stageInputs = () => healthyStageInputs().filter((i) => i.stage !== 4);
  const runs = fakeRuns({ stageInputs });
  const report = await runPipeline('t-missing', { withSelfAnalysis: false }, {}, runs);
  assert.equal(report.blocked, 'inputs');
  const v = report.inputs.violations.find((x) => x.code === VIOLATION.STAGE_RUN_MISSING);
  assert.ok(v && v.stage === 4);
  assert.equal(runs._lc.begin, 0);
});

test('разные ревизии стадий: снимки по разным документам не собираются вместе', async () => {
  const stageInputs = () => {
    const inputs = healthyStageInputs('docs_x');
    // Стадия 1 посчитана ДО перезалива документов, остальные — после.
    inputs.find((i) => i.stage === 1).run.documents_revision_id = 'docs_old';
    return inputs;
  };
  const runs = fakeRuns({ stageInputs });
  const report = await runPipeline('t-rev', { withSelfAnalysis: false }, {}, runs);

  assert.equal(report.blocked, 'inputs');
  const v = report.inputs.violations.find((x) => x.code === VIOLATION.STAGE_REVISION_MISMATCH);
  assert.ok(v, 'ожидалось stage_revision_mismatch');
  assert.equal(v.stage, 1);
  assert.equal(v.expected, 'docs_x');
  assert.equal(v.actual, 'docs_old');
  assert.equal(runs._lc.activate, 0);
});

test('легаси-снимок без ревизии документов не годится для production-сборки', async () => {
  const stageInputs = () => {
    const inputs = healthyStageInputs();
    inputs.find((i) => i.stage === 2).run.documents_revision_id = null;
    return inputs;
  };
  const runs = fakeRuns({ stageInputs });
  const report = await runPipeline('t-legacy', { withSelfAnalysis: false }, {}, runs);
  assert.equal(report.blocked, 'inputs');
  assert.ok(report.inputs.violations.some((v) => v.code === VIOLATION.STAGE_REVISION_UNKNOWN));
});

// Сдвиг ВО ВРЕМЯ сборки: шаги отработали по набору A, но к моменту активации
// указатель стадии показывает на другой прогон → снимок stale, активации нет.
test('смена stage pointer во время сборки → снимок НЕ активируется (stale)', async () => {
  let moved = false;
  const stageInputs = () => {
    const inputs = healthyStageInputs();
    if (moved) {
      const s2 = inputs.find((i) => i.stage === 2);
      s2.active_run_id = 'run_s2_new';
      s2.latest_run_id = 'run_s2_new';
      s2.run = { ...s2.run, id: 'run_s2_new' };
    }
    return inputs;
  };
  const runners = {
    draft_issues: async () => ({ summary: {} }),
    critic: async () => { moved = true; return { summary: {} }; }, // стадию 2 перегнали
    clustering: async () => ({ summary: { clusters: 2 } }),
  };
  const runs = fakeRuns({ stageInputs });

  const report = await runPipeline('t-moved', { withSelfAnalysis: false }, runners, runs);

  assert.equal(report.steps_done, 3, 'шаги успели выполниться');
  assert.equal(report.activated, false, 'stale-снимок не активируется');
  assert.equal(runs._lc.activate, 0, 'указатель конвейера остался на прежнем снимке');
  assert.equal(runs._lc.fail, 1, 'прогон помечен failed');
  assert.equal(report.stale_inputs, true);
  assert.equal(report.ok, false, 'успехом это не считается');
  assert.equal(report.status, STATUS.FAILED);
  const v = report.inputs.violations.find((x) => x.code === VIOLATION.STAGE_POINTER_MOVED);
  assert.ok(v, `ожидалось stage_pointer_moved, получено ${report.inputs.violations.map((x) => x.code)}`);
  assert.equal(v.expected, 'run_s2');
  assert.equal(v.actual, 'run_s2_new');
});

test('перезалив документов во время сборки → снимок НЕ активируется', async () => {
  let revision = 'docs_x';
  const runners = {
    draft_issues: async () => ({ summary: {} }),
    critic: async () => ({ summary: {} }),
    clustering: async () => { revision = 'docs_new'; return { summary: {} }; },
  };
  const runs = fakeRuns({ stageInputs: () => healthyStageInputs('docs_x'), documentsRevision: () => revision });

  const report = await runPipeline('t-docs', { withSelfAnalysis: false }, runners, runs);

  assert.equal(report.activated, false);
  assert.equal(report.stale_inputs, true);
  assert.equal(runs._lc.activate, 0);
  assert.ok(report.inputs.violations.some((v) => v.code === VIOLATION.DOCUMENTS_REVISION_CHANGED));
});

// --- Debug-режим: частичная сборка без перевода указателя ------------------------

test('debug-режим: неполный набор входов допускается, но указатель НЕ двигается', async () => {
  const stageInputs = () => healthyStageInputs().filter((i) => i.stage <= 2); // стадии 3–4 не гоняли
  const runners = {
    draft_issues: async () => ({ summary: {} }),
    critic: async () => ({ summary: {} }),
    clustering: async () => ({ summary: { clusters: 1 } }),
  };
  const runs = fakeRuns({ stageInputs });

  const report = await runPipeline('t-debug', { withSelfAnalysis: false, mode: 'debug' }, runners, runs);

  assert.equal(report.mode, MODE.DEBUG);
  assert.equal(report.ok, true, 'шаги посчитались — сборка как таковая удалась');
  assert.equal(report.activated, false, 'но основной указатель не переводится');
  assert.equal(runs._lc.activate, 0);
  assert.equal(runs._lc.completeNoActivate, 1, 'прогон закрыт без активации');
  assert.equal(runs._lc.fail, 0);
  assert.equal(report.inputs.ok, false, 'нарушения входов видны в отчёте, а не скрыты');
  assert.equal(runs._manifest.mode, MODE.DEBUG);
});

test('mode: только явное «debug» отключает проверки (fail-closed к production)', async () => {
  for (const mode of ['production', 'DEBUG_', 'prod', '', null, undefined, true, 'Production']) {
    const runs = fakeRuns({ stageInputs: () => healthyStageInputs().filter((i) => i.stage === 1) });
    // eslint-disable-next-line no-await-in-loop
    const report = await runPipeline('t-mode', { withSelfAnalysis: false, mode }, {}, runs);
    assert.equal(report.blocked, 'inputs', `mode=${JSON.stringify(mode)} обязан остаться production`);
  }
  // И регистр/пробелы явного debug не мешают.
  assert.equal(resolveMode({ mode: ' Debug ' }), MODE.DEBUG);
  assert.equal(resolveMode({}), MODE.PRODUCTION);
});

test('debug-сборка со сбоем шага остаётся сбоем (прогон failed, указатель цел)', async () => {
  const runners = {
    draft_issues: async () => ({ summary: {} }),
    critic: async () => { throw new Error('LLM недоступен'); },
    clustering: async () => ({ summary: {} }),
  };
  const runs = fakeRuns();
  const report = await runPipeline('t-debug-fail', { withSelfAnalysis: false, mode: 'debug' }, runners, runs);
  assert.equal(report.ok, false);
  assert.equal(report.activated, false);
  assert.equal(runs._lc.completeNoActivate, 0);
  assert.equal(runs._lc.fail, 1);
});

test('verifyInputsManifest: отсутствующий manifest — нарушение (fail-closed)', () => {
  for (const m of [null, undefined, {}, { stages: null }]) {
    const v = verifyInputsManifest(m, {});
    assert.equal(v.ok, false, `manifest ${JSON.stringify(m)} не должен считаться валидным`);
    assert.equal(v.violations[0].code, 'manifest_missing');
  }
  // Полный набор без current-состояния — проверка «до шагов» проходит.
  const good = buildInputsManifest({
    stageInputs: healthyStageInputs(), documentsRevisionId: 'docs_x', configVersion: 'cfg_x',
  });
  assert.equal(verifyInputsManifest(good, {}).ok, true);
  // Тот же manifest против неизменного состояния — проходит и «перед активацией».
  assert.equal(
    verifyInputsManifest(good, { stageInputs: healthyStageInputs(), documentsRevisionId: 'docs_x' }).ok,
    true,
  );
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
