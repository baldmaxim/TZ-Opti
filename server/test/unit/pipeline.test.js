'use strict';

// Юнит-тесты оркестратора конвейера (pipeline/analysisPipeline.js) — без БД и LLM.
// Проверяют чистое ядро: состав шагов прогона (planSteps), свёртку отчёта
// (summarizeRun), сохранение исхода в analysis_runs.summary и повторное чтение
// его через pipelineStatus, а также вычисление свежести слоёв (computeLayerStatus).
// Запуск: npm test.

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
  pipelineStatus,
  buildRunOutcome,
  parseRunOutcome,
  runStatusOf,
  MODE,
  resolveMode,
} = require('../../services/pipeline/analysisPipeline');
const { VIOLATION, buildInputsManifest, verifyInputsManifest } = require('../../services/pipeline/pipelineManifest');
const { STATUS, severityOf } = require('../../services/analysis/resultStatus');

// --- planSteps ----------------------------------------------------------------

test('planSteps: по умолчанию QC включён, challenger — нет (дорогой явный шаг)', () => {
  assert.deepEqual(planSteps(), ['draft_issues', 'critic', 'clustering', 'self_analysis']);
});

test('planSteps: withSelfAnalysis=false исключает QC-шаг', () => {
  assert.deepEqual(planSteps({ withSelfAnalysis: false }), ['draft_issues', 'critic', 'clustering']);
  // обязательные шаги не помечены опциональными — выключить их нельзя
  assert.equal(PIPELINE_STEPS.filter((s) => !s.optional).length, 3);
});

test('planSteps: withChallenger вставляет challenger МЕЖДУ кластеризацией и QC', () => {
  assert.deepEqual(
    planSteps({ withSelfAnalysis: true, withChallenger: true }),
    ['draft_issues', 'critic', 'clustering', 'challenger', 'self_analysis'],
  );
  // challenger можно включить и без QC (только поиск пропусков)
  assert.deepEqual(
    planSteps({ withSelfAnalysis: false, withChallenger: true }),
    ['draft_issues', 'critic', 'clustering', 'challenger'],
  );
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

// Заглушка реестра прогонов: без БД, но с мини-таблицей analysis_runs — строки
// прогонов переживают вызов, поэтому сохранённый исход (summary) можно прочитать
// обратно, как это делает портал после перезагрузки страницы.
// stageInputs — функция: возвращает состояние входов на МОМЕНТ вызова (так тест
// имитирует сдвиг указателя стадии во время сборки).
function fakeRuns({ stageInputs = () => healthyStageInputs(), documentsRevision = () => 'docs_x' } = {}) {
  const lc = { begin: 0, activate: 0, fail: 0, completeNoActivate: 0 };
  const rows = new Map(); // analysis_runs
  const pointers = new Map(); // analysis_active_runs
  let manifest = null;
  let seq = 0;
  const stamp = (n) => `2026-07-27T10:${String(n).padStart(2, '0')}:00.000Z`;
  const get = (id) => rows.get(id) || null;
  const finishRow = (id, patch) => { const r = get(id); if (r) Object.assign(r, patch); };
  return {
    SCOPE_PIPELINE: 'pipeline',
    currentDocumentsRevision: async () => documentsRevision(),
    currentConfigVersion: () => 'cfg_x',
    collectStageInputs: async (_t, stages = [1, 2, 3, 4]) => {
      const all = stageInputs();
      return stages.map((s) => all.find((i) => Number(i.stage) === Number(s)) || { stage: Number(s) });
    },
    beginRun: async (tenderId, _scope, opts = {}) => {
      lc.begin += 1;
      seq += 1;
      manifest = opts.inputsManifest || null;
      const id = seq === 1 ? 'run_x' : `run_x${seq}`;
      rows.set(id, {
        id,
        tender_id: tenderId,
        kind: 'pipeline',
        status: 'running',
        started_at: stamp(seq),
        finished_at: null,
        summary: null,
        superseded_at: null,
        documents_revision_id: opts.documentsRevisionId || null,
        config_version: opts.configVersion || null,
        inputs_manifest: manifest,
      });
      return id;
    },
    getRunInputsManifest: async (id) => (get(id) ? get(id).inputs_manifest : manifest),
    getRun: async (id) => (get(id) ? { ...get(id) } : null),
    getLatestPipelineRun: async () => {
      const list = [...rows.values()].filter((r) => r.kind === 'pipeline' && r.inputs_manifest);
      list.sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
      return list.length ? { ...list[0] } : null;
    },
    getActivePipelineRunId: async () => pointers.get('pipeline') || null,
    getActiveStageRunIds: async () => [],
    activateRun: async (_t, scope, runId, opts = {}) => {
      lc.activate += 1;
      const prev = pointers.get(scope);
      if (prev && prev !== runId) finishRow(prev, { superseded_at: stamp(59) });
      pointers.set(scope, runId);
      finishRow(runId, { status: 'completed', finished_at: stamp(59), summary: opts.summary ?? null });
    },
    completeRunWithoutActivation: async (runId, opts = {}) => {
      lc.completeNoActivate += 1;
      finishRow(runId, {
        status: 'completed', finished_at: stamp(59), summary: opts.summary ?? null, superseded_at: stamp(59),
      });
    },
    failRun: async (runId, summary) => {
      lc.fail += 1;
      finishRow(runId, { status: 'failed', finished_at: stamp(59), summary: summary ?? null });
    },
    _lc: lc,
    _rows: rows,
    _summaryOf: (id) => (get(id) ? get(id).summary : null),
    get _manifest() { return manifest; },
  };
}

// Заглушка db для pipelineStatus: слои пустые — тест смотрит на исход прогона,
// а не на счётчики таблиц.
const emptyLayersDb = { queryOne: async () => ({ c: 0, built_at: null }) };

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

// --- Сохранённый исход прогона (analysis_runs.summary) --------------------------
//
// Отчёт прогона пишется в БД целиком (статус, warnings, причины partial,
// failed_step, шаги, manifest входов, started_at/finished_at). Проверяем три
// исхода — успех, частичный, сбой — и ПОВТОРНОЕ ЧТЕНИЕ: pipelineStatus,
// вызванный заново (как после перезагрузки страницы или рестарта процесса),
// отдаёт тот же статус, который был зафиксирован при завершении.

const OK_RUNNERS = {
  draft_issues: async () => ({ summary: { draft_issues: 7 } }),
  critic: async () => ({ summary: { reviewed: 7 } }),
  clustering: async () => ({ summary: { clusters: 3 } }),
};

// Исход, реально записанный в analysis_runs.summary (а не то, что вернул вызов).
function savedOutcome(runs, runId) {
  const raw = runs._summaryOf(runId);
  assert.ok(raw, `в summary прогона ${runId} обязан лежать отчёт`);
  assert.equal(typeof raw, 'string', 'summary хранится JSON-строкой');
  const outcome = parseRunOutcome(raw);
  assert.ok(outcome, 'сохранённый summary обязан разбираться как отчёт прогона');
  return outcome;
}

test('успешный прогон: в summary записан полный отчёт (статус, шаги, manifest, времена)', async () => {
  const runs = fakeRuns();
  const report = await runPipeline('t-save-ok', { withSelfAnalysis: false }, OK_RUNNERS, runs);
  assert.equal(report.status, STATUS.COMPLETED);
  assert.equal(report.activated, true);

  const o = savedOutcome(runs, report.run_id);
  assert.equal(o.status, STATUS.COMPLETED);
  assert.equal(o.severity, 'success');
  assert.equal(o.ok, true);
  assert.equal(o.activated, true, 'в отчёте видно, что указатель переведён');
  assert.equal(o.mode, MODE.PRODUCTION);
  assert.equal(o.run_id, report.run_id);
  assert.equal(o.failed_step, null);
  assert.equal(o.warnings, null);
  assert.equal(o.partial, null);
  // Шаги целиком, со сводками раннеров.
  assert.deepEqual(o.steps.map((s) => s.step), ['draft_issues', 'critic', 'clustering']);
  assert.equal(o.steps_done, 3);
  assert.equal(o.steps_total, 3);
  assert.deepEqual(o.steps[2].summary, { clusters: 3 });
  // Manifest входов — из какого набора stage-прогонов собран снимок.
  assert.equal(o.inputs.ok, true);
  assert.deepEqual(o.inputs.manifest.required_stages, [1, 2, 3, 4]);
  assert.deepEqual(o.inputs.manifest.stages.map((s) => s.analysis_run_id),
    ['run_s1', 'run_s2', 'run_s3', 'run_s4']);
  // Времена прогона.
  assert.ok(o.started_at, 'started_at обязан быть в отчёте');
  assert.ok(o.finished_at, 'finished_at обязан быть в отчёте');
  assert.ok(o.finished_at >= o.started_at);
  // Ответ API и запись в БД — один отчёт.
  assert.equal(report.started_at, o.started_at);
  assert.equal(report.finished_at, o.finished_at);
});

test('частичный прогон: в summary — completed_with_warnings + причины partial', async () => {
  const runners = {
    ...OK_RUNNERS,
    self_analysis: async () => ({
      summary: { findings: 2, partial: true, failed_parts: [{ part: 2 }, { part: 5 }] },
    }),
  };
  const runs = fakeRuns();
  const report = await runPipeline('t-save-partial', {}, runners, runs);

  assert.equal(report.status, STATUS.COMPLETED_WITH_WARNINGS);
  assert.equal(report.ok, true);
  assert.equal(report.activated, true, 'частичный итог пригоден — указатель переводится');

  const o = savedOutcome(runs, report.run_id);
  assert.equal(o.status, STATUS.COMPLETED_WITH_WARNINGS);
  assert.equal(o.severity, 'warning', 'жёлтый, а не зелёный');
  assert.equal(o.failed_step, null);
  // warnings — как в отчёте API…
  assert.equal(o.warnings.length, 1);
  assert.equal(o.warnings[0].step, 'self_analysis');
  // …и отдельным списком причины partial (не надо разбирать шаги повторно).
  assert.equal(o.partial.length, 1);
  assert.equal(o.partial[0].step, 'self_analysis');
  assert.equal(o.partial[0].failed_parts, 2);
  assert.match(o.partial[0].reason, /2/);
});

test('неуспешный прогон: в summary — failed, сбойный шаг, шаги и manifest', async () => {
  const runners = {
    draft_issues: async () => ({ summary: { draft_issues: 1 } }),
    critic: async () => { throw new Error('LLM недоступен'); },
    clustering: async () => ({ summary: {} }),
  };
  const runs = fakeRuns();
  const report = await runPipeline('t-save-fail', { withSelfAnalysis: false }, runners, runs);

  assert.equal(report.status, STATUS.FAILED);
  const o = savedOutcome(runs, report.run_id);
  assert.equal(o.status, STATUS.FAILED);
  assert.equal(o.severity, 'error');
  assert.equal(o.ok, false);
  assert.equal(o.activated, false);
  assert.equal(o.failed_step, 'critic');
  assert.equal(o.steps_done, 1);
  assert.equal(o.steps_total, 3);
  assert.match(o.steps.find((s) => s.step === 'critic').error, /LLM недоступен/);
  assert.equal(o.steps.find((s) => s.step === 'clustering').status, 'skipped');
  assert.ok(o.inputs.manifest, 'manifest входов сохраняется и у провалившегося прогона');
  assert.ok(o.started_at && o.finished_at);
});

test('stale-входы: в summary видно, что снимок не активирован и почему', async () => {
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
  const runners = { ...OK_RUNNERS, critic: async () => { moved = true; return { summary: {} }; } };
  const runs = fakeRuns({ stageInputs });
  const report = await runPipeline('t-save-stale', { withSelfAnalysis: false }, runners, runs);

  const o = savedOutcome(runs, report.run_id);
  assert.equal(o.status, STATUS.FAILED);
  assert.equal(o.stale_inputs, true);
  assert.equal(o.activated, false);
  assert.equal(o.inputs.ok, false);
  assert.ok(o.inputs.violations.some((v) => v.code === VIOLATION.STAGE_POINTER_MOVED));
  assert.match(o.error, /не активирован/i);
});

test('debug-сборка: сохранённый отчёт помечен режимом debug и «указатель не переведён»', async () => {
  const runs = fakeRuns({ stageInputs: () => healthyStageInputs().filter((i) => i.stage <= 2) });
  const report = await runPipeline('t-save-debug', { withSelfAnalysis: false, mode: 'debug' }, OK_RUNNERS, runs);
  const o = savedOutcome(runs, report.run_id);
  assert.equal(o.mode, MODE.DEBUG);
  assert.equal(o.status, STATUS.COMPLETED);
  assert.equal(o.activated, false);
  assert.equal(o.inputs.ok, false, 'нарушения входов сохраняются, а не скрываются');
});

// --- Повторное чтение исхода из БД ---------------------------------------------
//
// pipelineStatus вызывается ЗАНОВО (в памяти вызывающего ничего не осталось —
// как после F5 или рестарта процесса) и обязан отдать тот же исход.

test('повторное чтение: pipelineStatus отдаёт зафиксированный исход успешного прогона', async () => {
  const runs = fakeRuns();
  const report = await runPipeline('t-read-ok', { withSelfAnalysis: false }, OK_RUNNERS, runs);

  const status = await pipelineStatus('t-read-ok', runs, emptyLayersDb);
  assert.equal(status.status, STATUS.COMPLETED, 'после перезагрузки — тот же completed');
  assert.equal(status.severity, 'success');
  assert.equal(status.failed_step, null);
  assert.equal(status.warnings, null);
  // Прогон под указателем и последний прогон — один и тот же снимок.
  assert.equal(status.active_run.run_id, report.run_id);
  assert.equal(status.last_run.run_id, report.run_id);
  assert.equal(status.active_run.status, STATUS.COMPLETED);
  assert.equal(status.active_run.activated, true);
  assert.equal(status.active_run.persisted, true, 'исход прочитан из БД, а не выведен по колонке status');
  assert.deepEqual(status.active_run.steps.map((s) => s.step), ['draft_issues', 'critic', 'clustering']);
  // Входные stage-прогоны видно и после перезагрузки.
  assert.deepEqual(status.stage_inputs.map((s) => s.analysis_run_id),
    ['run_s1', 'run_s2', 'run_s3', 'run_s4']);
  assert.ok(status.stage_inputs.every((s) => s.status === 'completed'));
  // Свежесть слоёв продолжает считаться.
  assert.equal(status.layers.length, 5);
});

test('повторное чтение: частичный итог остаётся completed_with_warnings (не зелёным)', async () => {
  const runners = {
    ...OK_RUNNERS,
    self_analysis: async () => ({ summary: { partial: true, failed_parts: [{ part: 1 }] } }),
  };
  const runs = fakeRuns();
  await runPipeline('t-read-partial', {}, runners, runs);

  const status = await pipelineStatus('t-read-partial', runs, emptyLayersDb);
  assert.equal(status.status, STATUS.COMPLETED_WITH_WARNINGS);
  assert.equal(status.severity, 'warning');
  assert.equal(status.warnings.length, 1);
  assert.equal(status.partial[0].step, 'self_analysis');
  assert.equal(status.active_run.status, STATUS.COMPLETED_WITH_WARNINGS,
    'узкая колонка БД знает только completed — статус берётся из сохранённого отчёта');
  assert.equal(status.active_run.run_status, 'completed');
});

// Провалившийся прогон указателем НЕ становится: без last_run его исход после
// перезагрузки исчез бы, и портал показал бы прежний успешный снимок как итог.
test('повторное чтение: сбой виден как failed, а указатель остаётся на прежнем успехе', async () => {
  const runs = fakeRuns();
  const good = await runPipeline('t-read-fail', { withSelfAnalysis: false }, OK_RUNNERS, runs);

  const failing = { ...OK_RUNNERS, clustering: async () => { throw new Error('кластеризация упала'); } };
  const bad = await runPipeline('t-read-fail', { withSelfAnalysis: false }, failing, runs);
  assert.notEqual(bad.run_id, good.run_id);

  const status = await pipelineStatus('t-read-fail', runs, emptyLayersDb);
  assert.equal(status.status, STATUS.FAILED, 'после перезагрузки виден тот же сбой');
  assert.equal(status.severity, 'error');
  assert.equal(status.failed_step, 'clustering');
  assert.equal(status.last_run.run_id, bad.run_id);
  assert.equal(status.last_run.activated, false);
  assert.match(status.last_run.steps.find((s) => s.step === 'clustering').error, /кластеризация упала/);
  // Указатель — на прежнем успешном снимке, и его исход тоже читается.
  assert.equal(status.active_run.run_id, good.run_id);
  assert.equal(status.active_run.status, STATUS.COMPLETED);
});

// --- Разбор сохранённого отчёта (чистые функции) --------------------------------

test('parseRunOutcome: чужой/битый summary не выдаётся за отчёт прогона', () => {
  assert.equal(parseRunOutcome(null), null);
  assert.equal(parseRunOutcome(''), null);
  assert.equal(parseRunOutcome('не json'), null);
  assert.equal(parseRunOutcome('{"backfill":true,"kind":"pipeline"}'), null, 'backfill-строка миграции — не отчёт');
  assert.equal(parseRunOutcome('{"candidate":true,"reason":"debug"}'), null);
  const o = buildRunOutcome({ status: STATUS.COMPLETED, ok: true, steps: [] });
  assert.deepEqual(parseRunOutcome(JSON.stringify(o)), o, 'свой отчёт разбирается без потерь');
  assert.deepEqual(parseRunOutcome(o), o, 'jsonb-колонка отдаёт объект — тоже принимается');
});

test('runStatusOf: без сохранённого отчёта статус выводится из колонки (fail-closed)', () => {
  assert.equal(runStatusOf({ status: 'completed' }, null), STATUS.COMPLETED);
  assert.equal(runStatusOf({ status: 'failed' }, null), STATUS.FAILED);
  assert.equal(runStatusOf({ status: 'cancelled' }, null), STATUS.CANCELLED);
  assert.equal(runStatusOf({ status: 'interrupted' }, null), STATUS.INTERRUPTED);
  assert.equal(runStatusOf({ status: 'running' }, null), null, 'прогон идёт — зафиксированного исхода нет');
  assert.equal(runStatusOf({ status: 'нечто' }, null), STATUS.FAILED, 'неизвестное — не успех');
  // Отчёт важнее колонки: completed_with_warnings колонка выразить не умеет.
  assert.equal(
    runStatusOf({ status: 'completed' }, { status: STATUS.COMPLETED_WITH_WARNINGS }),
    STATUS.COMPLETED_WITH_WARNINGS,
  );
});

test('легаси-прогон без отчёта: статус из колонки, входы — из inputs_manifest', async () => {
  const runs = fakeRuns();
  await runPipeline('t-legacy-row', { withSelfAnalysis: false }, OK_RUNNERS, runs);
  // Затираем сохранённый отчёт — так выглядит прогон, посчитанный до этой доработки.
  const row = [...runs._rows.values()][0];
  row.summary = '{"backfill":true}';

  const status = await pipelineStatus('t-legacy-row', runs, emptyLayersDb);
  assert.equal(status.status, STATUS.COMPLETED, 'выводим из колонки status');
  assert.equal(status.active_run.persisted, false, 'но честно помечаем: отчёт не сохранён');
  assert.equal(status.active_run.steps, null);
  assert.deepEqual(status.stage_inputs.map((s) => s.stage), [1, 2, 3, 4], 'входы всё равно видны — из manifest');
});

test('нет ни одного прогона конвейера: статус пуст, но не врёт про успех', async () => {
  const runs = fakeRuns();
  const status = await pipelineStatus('t-empty', runs, emptyLayersDb);
  assert.equal(status.status, null);
  assert.equal(status.severity, null);
  assert.equal(status.active_run, null);
  assert.equal(status.last_run, null);
  assert.deepEqual(status.stage_inputs, []);
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
