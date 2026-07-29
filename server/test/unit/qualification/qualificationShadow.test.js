'use strict';

// Юнит-тесты SHADOW-режима квалификационного gate — без БД, сети и LLM.
//
// Проверяется чистое ядро (qualificationShadowService + qualificationStats):
//   • маппинг кластера в находку gate (обязательный Markdown-вход);
//   • строки shadow-оценки (все требуемые поля) и evaluation_failed;
//   • сопоставление решения инженера с gate (review — retained, п.7 ТЗ);
//   • валидация override (структурированная причина обязательна);
//   • агрегированная статистика прогона;
//   • ХУК В КОНВЕЙЕРЕ: gate вызывается после кластеризации и ДО активации,
//     его сбой не меняет отчёт прогона (shadow-инвариант).
// Запуск: npm run test:unit.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const svc = require('../../../services/qualification/qualificationShadowService');
const statsMod = require('../../../services/qualification/qualificationStats');
const { qualifyFindings } = require('../../../services/qualification/findingQualificationGate');
const { runPipeline } = require('../../../services/pipeline/analysisPipeline');
const { STATUS } = require('../../../services/analysis/resultStatus');

// --- clusterToGateFinding -------------------------------------------------------

const CLUSTER = Object.freeze({
  id: 'cl-1',
  tender_id: 't-1',
  analysis_run_id: 'run-1',
  cluster_key: 'key-1',
  cluster_title: 'Открытый объём уборки',
  merged_basis: 'Обязанность не ограничена по объёму, в ВОР позиции нет.',
  merged_recommendation: 'Запросить лимит у заказчика',
  representative_fragment: 'Подрядчик обязан выполнять уборку по требованию заказчика.',
  final_problem_type: 'coverage_gap',
  impact_dimensions: '["price","scope"]',
  required_action: 'ask_customer',
  overall_impact_level: 'high',
  overall_criticality: 'high',
  verdict: 'publish',
});

const PRIMARY = Object.freeze({
  source_fragment: 'Подрядчик обязан выполнять уборку по требованию заказчика.',
  basis: 'В ВОР работы нет, объём не ограничен.',
  problem_type: 'coverage_gap',
  category: 'coverage',
  review_comment: 'Комментарий инженеру',
  suggested_action: 'clarify',
  suggested_redaction: 'Уборка — не чаще 1 раза в неделю.',
});

test('clusterToGateFinding: маппинг полей кластера + primary draft в формат gate', () => {
  const f = svc.clusterToGateFinding(CLUSTER, PRIMARY, 2);
  assert.equal(f.id, 'cl-1');
  assert.equal(f.rank, 3);
  assert.equal(f.quote, PRIMARY.source_fragment);
  assert.equal(f.summary, CLUSTER.cluster_title);
  assert.equal(f.basis, CLUSTER.merged_basis);
  assert.equal(f.problem_type, 'coverage_gap');
  assert.deepEqual(f.impact_dimensions, ['price', 'scope']);
  assert.equal(f.required_action, 'ask_customer');
  assert.equal(f.impact_level, 'high');
});

test('clusterToGateFinding: без primary draft берутся поля кластера (fallback)', () => {
  const f = svc.clusterToGateFinding(CLUSTER, null, 0);
  assert.equal(f.quote, CLUSTER.representative_fragment);
  assert.equal(f.basis, CLUSTER.merged_basis);
  assert.equal(f.rank, 1);
});

test('clusterToGateFinding + gate: реальная квалификация по Markdown-тексту (shadow, без мутаций)', () => {
  const sourceText = [
    '# ТЗ на СМР',
    '## 3. Обязанности подрядчика',
    'Подрядчик обязан выполнять уборку по требованию заказчика.',
    'Гарантийный срок — 5 лет.',
  ].join('\n');
  const finding = svc.clusterToGateFinding(CLUSTER, PRIMARY, 0);
  const before = JSON.stringify(finding);
  const [decision] = qualifyFindings([finding], { sourceText });
  assert.equal(decision.finding_id, 'cl-1');
  assert.ok(['publish', 'review', 'hide', 'reject'].includes(decision.qualification));
  assert.equal(JSON.stringify(finding), before, 'gate не мутирует вход (shadow mode)');
  // Цитата дословно есть в документе — reject «нет якоря» невозможен.
  assert.ok(!['no_quote', 'quote_not_in_document'].includes(decision.rule));
});

// --- Строки shadow-оценки --------------------------------------------------------

const GATE_DECISION = Object.freeze({
  finding_id: 'cl-1',
  qualification: 'review',
  priority: 'high',
  confidence: 0.62,
  evidence_strength: 'medium',
  impact_types: ['cost', 'scope'],
  source_strength: 0.7,
  missing_requirements: ['concrete_action'],
  reasons: ['Не названо конкретное действие'],
  score_breakdown: { evidence: 0.25, total: 0.62 },
  rule: 'no_concrete_action',
});

test('buildEvaluationRow: все требуемые поля shadow-результата на месте', () => {
  const row = svc.buildEvaluationRow(CLUSTER, GATE_DECISION, {
    runId: 'run-1', gateVersion: 'fq-test', evaluatedAt: '2026-07-29T10:00:00.000Z',
    sourceStages: [1, 4],
  });
  assert.equal(row.qualification, 'review');
  assert.equal(row.proposed_priority, 'high');
  assert.equal(row.confidence, 0.62);
  assert.equal(row.evidence_strength, 'medium');
  assert.deepEqual(JSON.parse(row.impact_types), ['cost', 'scope']);
  assert.equal(row.source_strength, 0.7);
  assert.deepEqual(JSON.parse(row.missing_requirements), ['concrete_action']);
  assert.deepEqual(JSON.parse(row.reasons), ['Не названо конкретное действие']);
  assert.equal(JSON.parse(row.score_breakdown).total, 0.62);
  assert.equal(row.gate_version, 'fq-test');
  assert.equal(row.evaluated_at, '2026-07-29T10:00:00.000Z');
  // Привязка к прогону и снимок production для сравнения.
  assert.equal(row.analysis_run_id, 'run-1');
  assert.equal(row.cluster_id, 'cl-1');
  assert.equal(row.production_verdict, 'publish');
  assert.equal(row.production_priority, 'high');
  assert.deepEqual(JSON.parse(row.source_stages), [1, 4]);
  assert.equal(row.error, null);
});

test('failedEvaluationRow: сбой gate фиксируется как evaluation_failed, замечание не трогается', () => {
  const row = svc.failedEvaluationRow(CLUSTER, {
    runId: 'run-1', gateVersion: 'fq-test', error: 'TZ_MD_MISSING: нет .md',
  });
  assert.equal(row.qualification, svc.EVALUATION_FAILED);
  assert.equal(row.error, 'TZ_MD_MISSING: нет .md');
  assert.deepEqual(JSON.parse(row.reasons), ['TZ_MD_MISSING: нет .md']);
  assert.equal(row.proposed_priority, null);
  assert.equal(row.production_verdict, 'publish', 'production-снимок сохраняется и при сбое');
});

// --- Согласие инженера с gate (retained = publish + review, п.7) ------------------

test('decisionAgreement: publish и review — retained; hide/reject — скрывающие', () => {
  const a = statsMod.decisionAgreement;
  // Совпадения.
  assert.equal(a('publish', 'accepted'), 1);
  assert.equal(a('review', 'accepted'), 1, 'review — НЕ скрытый результат (п.7)');
  assert.equal(a('review', 'accepted_with_edit'), 1);
  assert.equal(a('hide', 'rejected'), 1);
  assert.equal(a('reject', 'rejected'), 1);
  // Расхождения (в т.ч. false hide / false reject).
  assert.equal(a('hide', 'accepted'), 0);
  assert.equal(a('reject', 'accepted_with_edit'), 0);
  assert.equal(a('publish', 'rejected'), 0);
  assert.equal(a('review', 'rejected'), 0);
  // Не сопоставимо.
  assert.equal(a('publish', 'deferred'), null);
  assert.equal(a('hide', 'merged'), null);
  assert.equal(a(svc.EVALUATION_FAILED, 'accepted'), null);
  assert.equal(a(null, 'accepted'), null);
  assert.equal(a('publish', null), null);
});

// --- validateOverride --------------------------------------------------------------

test('validateOverride: rejected и accepted_with_edit требуют структурированную причину', () => {
  assert.throws(() => svc.validateOverride({ decision: 'rejected' }), /reason_code/);
  assert.throws(
    () => svc.validateOverride({ decision: 'accepted_with_edit', final_text: 'x' }),
    /reason_code/,
  );
  assert.throws(
    () => svc.validateOverride({ decision: 'rejected', reason_code: 'потому что' }),
    /Допустимые причины/,
  );
  const ok = svc.validateOverride({ decision: 'rejected', reason_code: 'no_material_impact' });
  assert.equal(ok.reason_code, 'no_material_impact');
});

test('validateOverride: словарь причин — ровно из ТЗ', () => {
  assert.deepEqual([...svc.OVERRIDE_REASON_CODES], [
    'no_material_impact', 'already_covered_by_vor', 'standard_requirement',
    'incorrect_interpretation', 'insufficient_evidence', 'duplicate',
    'outside_tender_scope', 'too_minor', 'wrong_priority', 'wrong_action', 'other',
  ]);
  assert.deepEqual([...svc.ENGINEER_DECISIONS], [
    'accepted', 'accepted_with_edit', 'rejected', 'deferred', 'merged',
  ]);
});

test('validateOverride: accepted_with_edit требует финальную редакцию; accepted/deferred/merged — нет', () => {
  assert.throws(
    () => svc.validateOverride({ decision: 'accepted_with_edit', reason_code: 'wrong_action' }),
    /final_text/,
  );
  const ok = svc.validateOverride({
    decision: 'accepted_with_edit', reason_code: 'wrong_action', final_text: 'Новая редакция', comment: 'к',
  });
  assert.equal(ok.final_text, 'Новая редакция');
  for (const d of ['accepted', 'deferred', 'merged']) {
    assert.equal(svc.validateOverride({ decision: d }).decision, d);
  }
  assert.throws(() => svc.validateOverride({ decision: 'approve' }), /Допустимые решения/);
});

// --- computeRunStats ----------------------------------------------------------------

function ev(clusterId, qualification, extra = {}) {
  return {
    cluster_id: clusterId,
    qualification,
    proposed_priority: null,
    production_priority: null,
    category: null,
    source_stages: [],
    ...extra,
  };
}
function dec(clusterId, decision, extra = {}) {
  return { cluster_id: clusterId, decision, decided_at: '2026-07-29T10:00:00.000Z', ...extra };
}

test('computeRunStats: квалификации, acceptance, false hide/reject, причины, приоритеты, разрезы', () => {
  const evaluations = [
    ev('c1', 'publish', { proposed_priority: 'high', production_priority: 'high', category: 'coverage', source_stages: [1] }),
    ev('c2', 'review', { proposed_priority: 'medium', production_priority: 'high', category: 'risk', source_stages: [4] }),
    ev('c3', 'hide', { category: 'coverage', source_stages: [1, 2] }),
    ev('c4', 'reject'),
    ev('c5', 'publish'),
    ev('c6', 'hide'),
    ev('c7', 'reject'),
    ev('c8', svc.EVALUATION_FAILED),
    ev('c9', 'publish', { proposed_priority: 'critical', production_priority: 'critical' }),
  ];
  const decisions = [
    // История: раннее решение по c1 перекрывается более поздним (latest wins).
    dec('c1', 'rejected', { reason_code: 'too_minor', decided_at: '2026-07-28T09:00:00.000Z' }),
    dec('c1', 'accepted'),
    dec('c2', 'accepted_with_edit', { reason_code: 'wrong_priority' }),
    dec('c3', 'accepted'), // false hide
    dec('c4', 'accepted_with_edit', { reason_code: 'other' }), // false reject
    dec('c5', 'rejected', { reason_code: 'no_material_impact' }),
    dec('c6', 'rejected', { reason_code: 'duplicate' }),
    dec('c8', 'deferred'),
    dec('c9', 'merged'),
  ];

  const s = statsMod.computeRunStats({ evaluations, decisions });

  assert.equal(s.total, 9);
  assert.deepEqual(s.qualifications, {
    publish: 3, review: 1, hide: 2, reject: 2, evaluation_failed: 1,
  });
  assert.equal(s.retained_by_gate, 4, 'retained = publish + review (п.7)');
  assert.equal(s.hidden_by_gate, 4);

  assert.equal(s.decided_total, 8);
  assert.deepEqual(s.decisions, {
    accepted: 2, accepted_with_edit: 2, rejected: 2, deferred: 1, merged: 1,
  });

  assert.deepEqual(s.agreement, { match: 3, mismatch: 3, not_comparable: 3 });
  assert.deepEqual(s.false_hide, { count: 1, cluster_ids: ['c3'] });
  assert.deepEqual(s.false_reject, { count: 1, cluster_ids: ['c4'] });
  assert.deepEqual(s.rejection_reasons, { no_material_impact: 1, duplicate: 1 });
  assert.deepEqual(s.edit_reasons, { wrong_priority: 1, other: 1 });
  assert.equal(s.edited_share, 0.5, '2 отредактированных из 4 оставленных');

  // Приоритеты: сопоставимы c1, c2, c9; расхождение только у c2.
  assert.equal(s.priority.comparable, 3);
  assert.equal(s.priority.mismatches, 1);
  assert.deepEqual(s.priority.pairs, [{ proposed: 'medium', production: 'high', count: 1 }]);

  // Acceptance по квалификации: publish — c1 accepted, c5 rejected, c9 merged.
  const pub = s.acceptance_by_qualification.publish;
  assert.equal(pub.total, 3);
  assert.equal(pub.decided, 3);
  assert.equal(pub.acceptance_rate, 0.5, 'merged не входит в знаменатель');
  const hid = s.acceptance_by_qualification.hide;
  assert.equal(hid.acceptance_rate, 0.5, 'c3 принят (false hide), c6 отклонён');

  // Разрезы.
  assert.equal(s.by_category.coverage.total, 2);
  assert.equal(s.by_category.risk.accepted_with_edit, 1);
  assert.equal(s.by_category.other.total, 6);
  assert.equal(s.by_stage['1'].total, 2, 'c1 и c3');
  assert.equal(s.by_stage['1'].acceptance_rate, 1);
  assert.equal(s.by_stage['4'].total, 1);
  assert.equal(s.by_stage.unknown.total, 6);
});

test('computeRunStats: пустой прогон — нули без деления на ноль', () => {
  const s = statsMod.computeRunStats({});
  assert.equal(s.total, 0);
  assert.equal(s.edited_share, null);
  assert.equal(s.priority.comparable, 0);
  assert.deepEqual(s.false_hide, { count: 0, cluster_ids: [] });
});

// --- Хук в конвейере: shadow-инварианты --------------------------------------------

function healthyStageInputs(revision = 'docs_x') {
  return [1, 2, 3, 4].map((stage) => ({
    stage,
    active_run_id: `run_s${stage}`,
    latest_run_id: `run_s${stage}`,
    run: {
      id: `run_s${stage}`, stage, status: 'completed',
      documents_revision_id: revision, config_version: 'cfg_x', superseded_at: null,
    },
  }));
}

// Минимальная заглушка реестра прогонов (как в pipeline.test.js).
function fakeRuns() {
  const lc = { activate: 0, fail: 0 };
  const rows = new Map();
  let manifest = null;
  return {
    SCOPE_PIPELINE: 'pipeline',
    currentDocumentsRevision: async () => 'docs_x',
    currentConfigVersion: () => 'cfg_x',
    collectStageInputs: async (_t, stages = [1, 2, 3, 4]) => {
      const all = healthyStageInputs();
      return stages.map((s) => all.find((i) => i.stage === Number(s)) || { stage: Number(s) });
    },
    beginRun: async (tenderId, _scope, opts = {}) => {
      manifest = opts.inputsManifest || null;
      rows.set('run_x', {
        id: 'run_x', tender_id: tenderId, kind: 'pipeline', status: 'running',
        started_at: '2026-07-29T10:00:00.000Z', finished_at: null, summary: null,
        superseded_at: null, inputs_manifest: manifest,
      });
      return 'run_x';
    },
    getRunInputsManifest: async () => manifest,
    getRun: async (id) => (rows.get(id) ? { ...rows.get(id) } : null),
    getLatestPipelineRun: async () => null,
    getActivePipelineRunId: async () => null,
    getActiveStageRunIds: async () => [],
    activateRun: async (_t, _scope, runId, opts = {}) => {
      lc.activate += 1;
      Object.assign(rows.get(runId), { status: 'completed', summary: opts.summary ?? null });
    },
    completeRunWithoutActivation: async () => {},
    failRun: async (runId, summary) => {
      lc.fail += 1;
      Object.assign(rows.get(runId), { status: 'failed', summary: summary ?? null });
    },
    _lc: lc,
  };
}

const OK_RUNNERS = {
  draft_issues: async () => ({ summary: { draft_issues: 2 } }),
  critic: async () => ({ summary: {} }),
  clustering: async () => ({ summary: { clusters: 2 } }),
};

test('конвейер: shadow-gate вызывается после кластеризации и ДО активации снимка', async () => {
  const calls = [];
  const runs = fakeRuns();
  const shadow = async (tenderId, runId, opts) => {
    calls.push({ tenderId, runId, trigger: opts.trigger, activationsAtCall: runs._lc.activate });
  };
  const report = await runPipeline('t-shadow', { withSelfAnalysis: false }, OK_RUNNERS, runs, shadow);
  assert.equal(report.ok, true);
  assert.equal(report.activated, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tenderId, 't-shadow');
  assert.equal(calls[0].runId, report.run_id);
  assert.equal(calls[0].trigger, 'pipeline');
  assert.equal(calls[0].activationsAtCall, 0, 'gate идёт ДО перевода указателя (до передачи клиенту)');
});

test('конвейер: СБОЙ shadow-gate не меняет исход прогона (ключевой shadow-инвариант)', async () => {
  const runs = fakeRuns();
  const shadow = async () => { throw new Error('gate взорвался'); };
  const report = await runPipeline('t-shadow-err', { withSelfAnalysis: false }, OK_RUNNERS, runs, shadow);
  assert.equal(report.ok, true, 'анализ не сломан');
  assert.equal(report.status, STATUS.COMPLETED);
  assert.equal(report.activated, true, 'указатель переводится как обычно');
  assert.equal(runs._lc.activate, 1);
  assert.equal(runs._lc.fail, 0);
  assert.ok(report.steps.every((s) => s.status === 'done'), 'shadow не является шагом конвейера');
});

test('конвейер: без собранных кластеров shadow-gate не вызывается', async () => {
  const calls = [];
  const runs = fakeRuns();
  const runners = { ...OK_RUNNERS, clustering: async () => { throw new Error('кластеризация упала'); } };
  const report = await runPipeline(
    't-shadow-skip', { withSelfAnalysis: false }, runners, runs,
    async (...a) => { calls.push(a); },
  );
  assert.equal(report.ok, false);
  assert.equal(calls.length, 0, 'нечего оценивать — gate не зовём');
});

test('конвейер: default-хук с QUALIFICATION_GATE_SHADOW=0 — прогон работает офлайн', async () => {
  // В тестовом env флаг выключен (test.env): default evaluateRunSafe обязан
  // мгновенно вернуть skipped, не трогая БД, — прогон полностью офлайн.
  assert.equal(svc.shadowEnabled(), false);
  const runs = fakeRuns();
  const report = await runPipeline('t-shadow-default', { withSelfAnalysis: false }, OK_RUNNERS, runs);
  assert.equal(report.ok, true);
  assert.equal(report.activated, true);
});

test('evaluateRunSafe: при выключенном флаге не ходит в БД и возвращает skipped', async () => {
  const res = await svc.evaluateRunSafe('t-x', 'run-x');
  assert.deepEqual(res, { skipped: true, reason: 'QUALIFICATION_GATE_SHADOW=0' });
});

test('shadowEnabled: включён по умолчанию, выключается только «0»', () => {
  assert.equal(svc.shadowEnabled({}), true);
  assert.equal(svc.shadowEnabled({ QUALIFICATION_GATE_SHADOW: '1' }), true);
  assert.equal(svc.shadowEnabled({ QUALIFICATION_GATE_SHADOW: '0' }), false);
  assert.equal(svc.shadowEnabled({ QUALIFICATION_GATE_SHADOW: ' 0 ' }), false);
});
