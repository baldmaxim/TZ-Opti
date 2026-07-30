'use strict';

// Integration: SHADOW-РЕЖИМ квалификационного gate — круг через Postgres.
//
// КЛЮЧЕВОЙ ИНВАРИАНТ (требование ТЗ): shadow mode не меняет НИ ОДНО
// production-замечание, экспорт или active analysis pointer. Проверяется
// побайтовым сравнением снимков production-таблиц до и после всех
// shadow-операций (оценка из конвейера, повторная оценка, override, статистика).
//
// Дополнительно:
//   • оценка привязана к analysis_run_id и версии gate; повтор той же версии
//     НЕ перезаписывает строки; переоценка — только новой версией;
//   • обязательный Markdown-вход: без .md ТЗ оценка = evaluation_failed;
//   • сбой gate не бросает (evaluateRunSafe) и фиксируется в audit_log;
//   • решение инженера с обязательной структурированной причиной + сравнение
//     с gate (agrees_with_gate).
//
//   npm run test:integration    — без TEST_DATABASE_URL тесты SKIP
//   npm run verify:integration  — без TEST_DATABASE_URL тесты ПАДАЮТ

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { dbTestOptions, getDb, closeDb } = require('../helpers/testDb');
const analysisRuns = require('../../services/analysisRuns/analysisRunsService');
const pipeline = require('../../services/pipeline/analysisPipeline');
const clusterReview = require('../../services/review/clusterReviewService');
const svc = require('../../services/qualification/qualificationShadowService');
const { STATUS } = require('../../services/analysis/resultStatus');

const OPTS = dbTestOptions();
const TENDER_ID = 'qualification-shadow-tender';
const TENDER_NO_MD = 'qualification-shadow-no-md';

const nowIso = () => new Date().toISOString();

const QUOTE_A = 'Подрядчик обязан обеспечить ежедневную уборку строительной площадки и вывоз строительного мусора.';
const QUOTE_B = 'Гарантийный срок на выполненные работы составляет 5 лет с даты подписания акта.';
const TZ_MD = [
  '# Техническое задание на СМР',
  '## 1. Обязанности подрядчика',
  QUOTE_A,
  '## 2. Гарантия',
  QUOTE_B,
].join('\n');

let prevFlag;

async function cleanup(db) {
  for (const tid of [TENDER_ID, TENDER_NO_MD]) {
    // eslint-disable-next-line no-await-in-loop
    await db.queryRun('DELETE FROM analysis_active_runs WHERE tender_id = ?', tid);
    // У review_decisions нет tender_id — чистим через прогоны тендера.
    await db.queryRun(
      'DELETE FROM review_decisions WHERE analysis_run_id IN (SELECT id FROM analysis_runs WHERE tender_id = ?)',
      tid,
    );
    for (const t of ['finding_qualification_decisions', 'finding_qualifications',
      'issue_clusters', 'issue_reviews', 'draft_issues',
      'self_analysis_results', 'analysis_signals', 'issues', 'analysis_segments',
      'audit_log', 'documents', 'analysis_runs']) {
      // eslint-disable-next-line no-await-in-loop
      await db.queryRun(`DELETE FROM ${t} WHERE tender_id = ?`, tid);
    }
    // eslint-disable-next-line no-await-in-loop
    await db.queryRun('DELETE FROM tenders WHERE id = ?', tid);
  }
}

before(async () => {
  if (OPTS.skip) return;
  prevFlag = process.env.QUALIFICATION_GATE_SHADOW;
  process.env.QUALIFICATION_GATE_SHADOW = '1'; // включаем production-хук в тесте
  const { runMigration } = require('../../db/migrate');
  await runMigration();
  const db = getDb();
  await cleanup(db);
  await db.queryRun(
    'INSERT INTO tenders (id, title, status, created_at) VALUES (?, ?, ?, ?)',
    TENDER_ID, 'Shadow-квалификация', 'draft', nowIso(),
  );
  // ОБЯЗАТЕЛЬНЫЙ Markdown-вход gate: .md ТЗ в слоте doc_type='tz'.
  await db.queryRun(
    `INSERT INTO documents (id, tender_id, doc_type, name, file_path, uploaded_at, extracted_text, processing_status)
     VALUES (?, ?, 'tz', 'tz.md', 'virtual://tz.md', ?, ?, 'extracted')`,
    'doc-shadow-md', TENDER_ID, nowIso(), TZ_MD,
  );
});

after(async () => {
  if (OPTS.skip) return;
  if (prevFlag === undefined) delete process.env.QUALIFICATION_GATE_SHADOW;
  else process.env.QUALIFICATION_GATE_SHADOW = prevFlag;
  const db = getDb();
  await cleanup(db);
  await closeDb();
});

// Полный валидный набор stage-входов конвейера: стадии 1–4 completed.
async function seedStageSnapshots() {
  const documentsRevisionId = await analysisRuns.currentDocumentsRevision(TENDER_ID);
  const configVersion = analysisRuns.currentConfigVersion();
  const ids = {};
  for (const stage of [1, 2, 3, 4]) {
    // eslint-disable-next-line no-await-in-loop
    const runId = await analysisRuns.beginRun(TENDER_ID, analysisRuns.stageScope(stage), {
      stage, documentsRevisionId, configVersion,
    });
    // eslint-disable-next-line no-await-in-loop
    await analysisRuns.activateRun(TENDER_ID, analysisRuns.stageScope(stage), runId, {
      documentsRevisionId, configVersion,
    });
    ids[stage] = runId;
  }
  return ids;
}

// Сигналы стадий (для source_stages в shadow-оценке).
async function seedSignals(db, stageRuns) {
  const rows = [
    ['sig-shadow-a', 1, stageRuns[1], QUOTE_A],
    ['sig-shadow-b', 4, stageRuns[4], QUOTE_B],
  ];
  for (const [id, stage, runId, quote] of rows) {
    // eslint-disable-next-line no-await-in-loop
    await db.queryRun(
      `INSERT INTO analysis_signals
         (id, tender_id, analysis_run_id, analysis_stage, signal_type, source_fragment, created_at)
       VALUES (?, ?, ?, ?, 'coverage', ?, ?)`,
      id, TENDER_ID, runId, stage, quote, nowIso(),
    );
  }
}

// Раннеры конвейера пишут НАСТОЯЩИЕ production-строки в снимок runId —
// два итоговых замечания: A (publish) и B (suppress).
function makeRunners(db) {
  return {
    draft_issues: async (tenderId, runId) => {
      const drafts = [
        ['dr-shadow-a', '1. Обязанности подрядчика', QUOTE_A, 'coverage_gap', 'coverage',
          'Обязанность уборки не ограничена по объёму, в ВОР позиции уборки и вывоза мусора нет — расчёт занижен.',
          'clarify', 'Уборка — не чаще одного раза в неделю.', '["sig-shadow-a"]', 2,
          'high', 'medium', 'publish', '["price","scope"]', 'ask_customer'],
        ['dr-shadow-b', '2. Гарантия', QUOTE_B, 'standard_requirement', 'risk',
          'Стандартное гарантийное требование.',
          'accept', null, '["sig-shadow-b"]', 4,
          'low', 'weak', 'suppress', '[]', 'none'],
      ];
      for (const d of drafts) {
        // eslint-disable-next-line no-await-in-loop
        await db.queryRun(
          `INSERT INTO draft_issues
             (id, tender_id, analysis_run_id, tz_clause, source_fragment, problem_type, category,
              basis, suggested_action, suggested_redaction, created_from_signal_ids, paragraph_index,
              impact_level, evidence_level, verdict, impact_dimensions, required_action, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          d[0], tenderId, runId, d[1], d[2], d[3], d[4], d[5], d[6], d[7], d[8], d[9],
          d[10], d[11], d[12], d[13], d[14], nowIso(),
        );
      }
      return { summary: { draft_issues: 2 } };
    },
    critic: async (tenderId, runId) => {
      for (const [id, draftId, verdict, impact] of [
        ['rv-shadow-a', 'dr-shadow-a', 'publish', 'high'],
        ['rv-shadow-b', 'dr-shadow-b', 'suppress', 'low'],
      ]) {
        // eslint-disable-next-line no-await-in-loop
        await db.queryRun(
          `INSERT INTO issue_reviews
             (id, tender_id, analysis_run_id, draft_issue_id, verdict, impact_level,
              evidence_level, show_to_engineer, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'medium', ?, ?)`,
          id, tenderId, runId, draftId, verdict, impact, verdict === 'publish' ? 1 : 0, nowIso(),
        );
      }
      return { summary: { reviewed: 2 } };
    },
    clustering: async (tenderId, runId) => {
      const clusters = [
        ['cl-shadow-a', 'dr-shadow-a', '1. Обязанности подрядчика', 'Уборка и вывоз мусора: открытый объём',
          'Обязанность уборки не ограничена, в ВОР позиции нет — расчёт занижен.',
          'Запросить у заказчика лимит уборки', 'high', 1, 'coverage_gap',
          'publish', 'high', 'medium', '["price","scope"]', 'ask_customer', QUOTE_A, 'ck-shadow-a', 2],
        ['cl-shadow-b', 'dr-shadow-b', '2. Гарантия', 'Гарантия 5 лет — стандартное требование',
          'Стандартное гарантийное требование без дополнительного риска.',
          'Принять к сведению', 'low', 0, 'standard_requirement',
          'suppress', 'low', 'weak', '[]', 'none', QUOTE_B, 'ck-shadow-b', 4],
      ];
      for (const c of clusters) {
        // eslint-disable-next-line no-await-in-loop
        await db.queryRun(
          `INSERT INTO issue_clusters
             (id, tender_id, analysis_run_id, tz_clause, cluster_title, merged_basis,
              merged_recommendation, overall_criticality, show_to_engineer, final_problem_type,
              verdict, overall_impact_level, overall_evidence_level, impact_dimensions,
              required_action, representative_fragment, cluster_key, paragraph_index,
              occurrence_count, item_count, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?)`,
          c[0], tenderId, runId, c[2], c[3], c[4], c[5], c[6], c[7], c[8],
          c[9], c[10], c[11], c[12], c[13], c[14], c[15], c[16], nowIso(),
        );
        // eslint-disable-next-line no-await-in-loop
        await db.queryRun(
          `INSERT INTO issue_cluster_items (id, cluster_id, draft_issue_id, item_role, created_at)
           VALUES (?, ?, ?, 'primary', ?)`,
          `ci-${c[0]}`, c[0], c[1], nowIso(),
        );
      }
      return { summary: { clusters: 2 } };
    },
  };
}

// Снимок ВСЕГО production-состояния тендера: замечания, решения, указатели,
// прогоны и строки экспорта. Любое изменение любого байта — провал инварианта.
async function snapshotProduction(db) {
  const all = (sql, ...p) => db.queryAll(sql, ...p);
  return {
    clusters: await all('SELECT * FROM issue_clusters WHERE tender_id = ? ORDER BY id', TENDER_ID),
    cluster_items: await all(
      `SELECT * FROM issue_cluster_items WHERE cluster_id IN
         (SELECT id FROM issue_clusters WHERE tender_id = ?) ORDER BY id`, TENDER_ID),
    draft_issues: await all('SELECT * FROM draft_issues WHERE tender_id = ? ORDER BY id', TENDER_ID),
    issue_reviews: await all('SELECT * FROM issue_reviews WHERE tender_id = ? ORDER BY id', TENDER_ID),
    review_decisions: await all(
      `SELECT * FROM review_decisions WHERE analysis_run_id IN
         (SELECT id FROM analysis_runs WHERE tender_id = ?) ORDER BY id`, TENDER_ID),
    pointers: await all('SELECT * FROM analysis_active_runs WHERE tender_id = ? ORDER BY scope', TENDER_ID),
    runs: await all(
      'SELECT id, status, summary, superseded_at, finished_at FROM analysis_runs WHERE tender_id = ? ORDER BY id',
      TENDER_ID),
    export_rows: await clusterReview.loadClusterDecisions(TENDER_ID),
  };
}

let runId = null; // pipeline-прогон, общий для последовательных тестов файла

test('конвейер + shadow: gate оценил итоговые замечания, production не изменился', OPTS, async () => {
  const db = getDb();
  const stageRuns = await seedStageSnapshots();
  await seedSignals(db, stageRuns);

  const report = await pipeline.runPipeline(TENDER_ID, { withSelfAnalysis: false }, makeRunners(db));
  assert.equal(report.status, STATUS.COMPLETED, JSON.stringify(report));
  assert.equal(report.activated, true);
  runId = report.run_id;

  // Shadow-оценки посчитаны в снимке прогона и версии gate.
  const rows = await db.queryAll(
    'SELECT * FROM finding_qualifications WHERE tender_id = ? AND analysis_run_id = ? ORDER BY cluster_id',
    TENDER_ID, runId,
  );
  assert.equal(rows.length, 2, 'по одной оценке на каждое итоговое замечание');
  for (const r of rows) {
    assert.equal(r.gate_version, svc.GATE_VERSION);
    assert.ok(['publish', 'review', 'hide', 'reject'].includes(r.qualification),
      `оценка обязана посчитаться (получено ${r.qualification}: ${r.error})`);
    assert.ok(r.evaluated_at);
    assert.ok(r.proposed_priority);
    assert.ok(r.evidence_strength);
    assert.ok(Array.isArray(JSON.parse(r.reasons)) && JSON.parse(r.reasons).length > 0);
    assert.ok(JSON.parse(r.score_breakdown).total !== undefined);
  }
  const byCluster = Object.fromEntries(rows.map((r) => [r.cluster_id, r]));
  // Снимок production для сравнения + стадии-источники.
  assert.equal(byCluster['cl-shadow-a'].production_verdict, 'publish');
  assert.equal(byCluster['cl-shadow-a'].production_priority, 'high');
  assert.deepEqual(JSON.parse(byCluster['cl-shadow-a'].source_stages), [1]);
  assert.equal(byCluster['cl-shadow-b'].production_verdict, 'suppress');
  assert.deepEqual(JSON.parse(byCluster['cl-shadow-b'].source_stages), [4]);

  // Production-решение инженера (обычный путь рецензии) — чтобы экспорт был непустым.
  await clusterReview.saveClusterDecision(TENDER_ID, 'cl-shadow-a', {
    decision: 'accept', final_comment: 'Принято',
  });

  // ===== КЛЮЧЕВОЙ ИНВАРИАНТ =====
  const before = await snapshotProduction(db);
  assert.equal(before.export_rows.length, 1, 'экспорт видит production-решение');

  // Все shadow-операции подряд.
  await svc.rerunGate(TENDER_ID, {}); // та же версия
  await svc.rerunGate(TENDER_ID, { gateVersion: 'fq-gate-v2-test' }); // новая версия
  await svc.saveOverride(TENDER_ID, 'cl-shadow-a', {
    decision: 'rejected', reason_code: 'already_covered_by_vor', comment: 'Уже в смете',
  }, { subject: 'eng-1', email: 'eng@example.com' });
  await svc.runStats(TENDER_ID, {});
  await svc.listEvaluations(TENDER_ID, {});
  await svc.evaluateRunSafe(TENDER_ID, runId);

  const after = await snapshotProduction(db);
  assert.deepEqual(after, before,
    'shadow mode не должен изменить ни одно production-замечание, экспорт или active pointer');
  assert.equal(await analysisRuns.getActivePipelineRunId(TENDER_ID), runId,
    'active analysis pointer не сдвинулся');
});

test('повторная оценка той же версией НЕ перезаписывает строки', OPTS, async () => {
  const db = getDb();
  const first = await db.queryAll(
    'SELECT id, evaluated_at, qualification FROM finding_qualifications WHERE analysis_run_id = ? AND gate_version = ? ORDER BY cluster_id',
    runId, svc.GATE_VERSION,
  );
  const res = await svc.rerunGate(TENDER_ID, { runId, gateVersion: svc.GATE_VERSION });
  assert.equal(res.evaluated, 0, 'ни одна строка не пересчитана');
  assert.equal(res.skipped_existing, 2);
  const second = await db.queryAll(
    'SELECT id, evaluated_at, qualification FROM finding_qualifications WHERE analysis_run_id = ? AND gate_version = ? ORDER BY cluster_id',
    runId, svc.GATE_VERSION,
  );
  assert.deepEqual(second, first, 'id/evaluated_at/qualification неизменны');
});

test('переоценка новой версией gate: новые строки, исходные findings и старые оценки не тронуты', OPTS, async () => {
  const db = getDb();
  const v2 = await db.queryAll(
    'SELECT * FROM finding_qualifications WHERE analysis_run_id = ? AND gate_version = ? ORDER BY cluster_id',
    runId, 'fq-gate-v2-test',
  );
  assert.equal(v2.length, 2, 'оценка новой версией существует для каждого замечания');
  const versions = (await svc.listEvaluations(TENDER_ID, { runId })).versions
    .map((v) => v.gate_version).sort();
  assert.deepEqual(versions, [svc.GATE_VERSION, 'fq-gate-v2-test'].sort());
  const v1count = await db.queryOne(
    'SELECT COUNT(*) AS c FROM finding_qualifications WHERE analysis_run_id = ? AND gate_version = ?',
    runId, svc.GATE_VERSION,
  );
  assert.equal(Number(v1count.c), 2, 'старые оценки на месте');
});

test('override: обязательная структурированная причина + сравнение с gate + автор', OPTS, async () => {
  const db = getDb();
  // rejected без причины — отказ.
  await assert.rejects(
    () => svc.saveOverride(TENDER_ID, 'cl-shadow-a', { decision: 'rejected' }),
    /reason_code/,
  );
  // Сохранённое в ключевом тесте решение: rejected + already_covered_by_vor.
  const row = await db.queryOne(
    `SELECT * FROM finding_qualification_decisions
      WHERE tender_id = ? AND cluster_id = ? ORDER BY decided_at DESC LIMIT 1`,
    TENDER_ID, 'cl-shadow-a',
  );
  assert.ok(row, 'решение инженера сохранено');
  assert.equal(row.decision, 'rejected');
  assert.equal(row.reason_code, 'already_covered_by_vor');
  assert.equal(row.comment, 'Уже в смете');
  assert.equal(row.decided_by, 'eng-1');
  assert.equal(row.decided_by_email, 'eng@example.com');
  assert.ok(row.decided_at);
  assert.ok(row.original_text, 'исходная редакция замечания зафиксирована');
  assert.ok(row.gate_qualification, 'квалификация gate на момент решения зафиксирована');
  // gate оставил замечание (publish|review), инженер отклонил → расхождение.
  const expected = ['publish', 'review'].includes(row.gate_qualification) ? 0 : 1;
  assert.equal(Number(row.agrees_with_gate), expected);

  // accepted_with_edit: сохраняются исходная и финальная редакции.
  const saved = await svc.saveOverride(TENDER_ID, 'cl-shadow-a', {
    decision: 'accepted_with_edit', reason_code: 'wrong_action',
    final_text: 'Уборка — по графику, не чаще 1 раза в неделю.',
  }, { subject: 'eng-2' });
  assert.equal(saved.decision.final_text, 'Уборка — по графику, не чаще 1 раза в неделю.');
  assert.ok(saved.decision.original_text);
  // review_decisions (production) от shadow-override не изменился.
  const prod = await db.queryAll(
    'SELECT decision FROM review_decisions WHERE cluster_id = ?', 'cl-shadow-a',
  );
  assert.deepEqual(prod.map((r) => r.decision), ['accept']);
});

test('статистика прогона: квалификации × решения, причины, приоритеты, разрезы', OPTS, async () => {
  const res = await svc.runStats(TENDER_ID, { runId, gateVersion: svc.GATE_VERSION });
  assert.equal(res.run_id, runId);
  assert.equal(res.gate_version, svc.GATE_VERSION);
  const s = res.stats;
  assert.equal(s.total, 2);
  const sum = Object.values(s.qualifications).reduce((a, b) => a + b, 0);
  assert.equal(sum, 2);
  assert.equal(s.qualifications.evaluation_failed, 0);
  // Последнее решение по cl-shadow-a — accepted_with_edit (см. тест override).
  assert.equal(s.decisions.accepted_with_edit, 1);
  assert.equal(s.edit_reasons.wrong_action, 1);
  assert.equal(s.edited_share, 1);
  assert.ok(s.acceptance_by_qualification);
  assert.ok(s.by_category);
  assert.ok(s.by_stage['1'], 'разрез по стадии-источнику');
  assert.ok(s.priority.comparable >= 1);
});

test('обязательный Markdown-вход: без .md ТЗ оценка = evaluation_failed, замечание не тронуто', OPTS, async () => {
  const db = getDb();
  await db.queryRun(
    'INSERT INTO tenders (id, title, status, created_at) VALUES (?, ?, ?, ?)',
    TENDER_NO_MD, 'Без Markdown', 'draft', nowIso(),
  );
  await db.queryRun(
    `INSERT INTO analysis_runs (id, tender_id, stage, kind, started_at, finished_at, status)
     VALUES ('run-no-md', ?, NULL, 'pipeline', ?, ?, 'completed')`,
    TENDER_NO_MD, nowIso(), nowIso(),
  );
  // occurrence_count задаём явно: миграция добивает NULL → 1 (backfill), а
  // параллельный тестовый файл может прогнать runMigration между снимком «до»
  // и чтением «после» — сравнение ловило бы чужую правку, а не evaluateRun.
  await db.queryRun(
    `INSERT INTO issue_clusters
       (id, tender_id, analysis_run_id, cluster_title, verdict, overall_impact_level, occurrence_count, created_at)
     VALUES ('cl-no-md', ?, 'run-no-md', 'Замечание без ТЗ', 'publish', 'high', 1, ?)`,
    TENDER_NO_MD, nowIso(),
  );
  const clusterBefore = await db.queryOne('SELECT * FROM issue_clusters WHERE id = ?', 'cl-no-md');

  const res = await svc.evaluateRun(TENDER_NO_MD, 'run-no-md');
  assert.equal(res.total, 1);
  assert.equal(res.failed, 1);
  const row = await db.queryOne(
    'SELECT * FROM finding_qualifications WHERE analysis_run_id = ?', 'run-no-md',
  );
  assert.equal(row.qualification, 'evaluation_failed');
  assert.match(row.error, /TZ_MD_MISSING/);

  const clusterAfter = await db.queryOne('SELECT * FROM issue_clusters WHERE id = ?', 'cl-no-md');
  assert.deepEqual(clusterAfter, clusterBefore, 'замечание сохранено как есть');
});

test('evaluateRunSafe: ошибка gate не бросает и фиксируется в audit_log', OPTS, async () => {
  const db = getDb();
  const res = await svc.evaluateRunSafe(TENDER_ID, 'run-does-not-exist');
  assert.equal(res.ok, false, 'сбой возвращается отчётом, не исключением');
  assert.ok(res.error);
  const auditRow = await db.queryOne(
    `SELECT * FROM audit_log WHERE tender_id = ? AND action = 'qualification.gate.error'
      ORDER BY ts DESC LIMIT 1`,
    TENDER_ID,
  );
  assert.ok(auditRow, 'ошибка gate записана в журнал аудита');
  assert.equal(auditRow.outcome, 'error');
  assert.equal(auditRow.category, 'analysis');
});
