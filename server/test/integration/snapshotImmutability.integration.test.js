'use strict';

// Integration: НЕИЗМЕНЯЕМОСТЬ СНИМКОВ анализа.
//
// Что защищаем:
//   • в completed и в superseded прогон писать нельзя (страж уровня сервиса) —
//     раньше build* без runId получал АКТИВНЫЙ прогон через ensurePipelineRun и
//     делал в нём DELETE+INSERT, подменяя уже выданный инженеру результат;
//   • build без runId пишет в НОВЫЙ прогон-кандидат и НЕ переводит указатель
//     (debug-путь не меняет production-снимок);
//   • сбой нового прогона сохраняет старый результат: указатель, кластеры и
//     решения прежнего снимка на месте;
//   • сброс стадии не удаляет историю (прогоны/issues/решения остаются), а снимает
//     указатели и пишет событие в журнал аудита;
//   • физическое удаление — только admin-purge, и он не трогает актуальный снимок.
//
//   npm run test:integration    — без TEST_DATABASE_URL тесты SKIP
//   npm run verify:integration  — без TEST_DATABASE_URL тесты ПАДАЮТ

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { dbTestOptions, getDb, closeDb } = require('../helpers/testDb');
const analysisRuns = require('../../services/analysisRuns/analysisRunsService');
const unified = require('../../services/unifiedAnalysis/unifiedIssueBuilder');
const pipeline = require('../../services/pipeline/analysisPipeline');
const engine = require('../../services/stageAnalysis/stageAnalysisEngine');
const purge = require('../../services/admin/purgeService');

const OPTS = dbTestOptions();
const TENDER_ID = 'snapshot-immutable-tender';

const nowIso = () => new Date().toISOString();

// --- Фикстуры -----------------------------------------------------------------

async function addDraft(db, id, runId, fragment = 'фрагмент') {
  await db.queryRun(
    `INSERT INTO draft_issues (id, tender_id, analysis_run_id, tz_clause, source_fragment,
       problem_type, category, basis, suggested_action, confidence, paragraph_index, created_at)
     VALUES (?, ?, ?, 'п. 1.1', ?, 'не_учтено_в_кп', 'coverage', 'основание', 'comment', 0.8, 1, ?)`,
    id, TENDER_ID, runId, fragment, nowIso(),
  );
}

async function addCluster(db, id, runId, key = 'k1') {
  await db.queryRun(
    `INSERT INTO issue_clusters (id, tender_id, analysis_run_id, tz_clause, cluster_title,
       merged_basis, merged_recommendation, overall_criticality, show_to_engineer,
       final_problem_type, semantic_bucket, cluster_key, item_count, paragraph_index, created_at)
     VALUES (?, ?, ?, 'п. 1.1', 'Кластер', 'основание', 'рекомендация', 'high', 1,
       'не_учтено_в_кп', 'price|modify', ?, 1, 1, ?)`,
    id, TENDER_ID, runId, key, nowIso(),
  );
}

async function addClusterDecision(db, id, clusterId, runId) {
  await db.queryRun(
    `INSERT INTO review_decisions (id, issue_id, cluster_id, analysis_run_id, cluster_key,
       decision, final_comment, decided_at)
     VALUES (?, NULL, ?, ?, 'k1', 'accept', 'решение инженера', ?)`,
    id, clusterId, runId, nowIso(),
  );
}

async function addStageIssue(db, id, runId, stage) {
  await db.queryRun(
    `INSERT INTO issues (id, tender_id, analysis_run_id, analysis_stage, source_fragment,
       problem_type, criticality, review_status)
     VALUES (?, ?, ?, ?, 'фрагмент', 'не_учтено_в_кп', 'high', 'pending')`,
    id, TENDER_ID, runId, stage,
  );
}

// Полный валидный набор входов конвейера: стадии 1–4 completed по текущей ревизии.
async function seedStageSnapshots(db, { stages = [1, 2, 3, 4] } = {}) {
  const documentsRevisionId = await analysisRuns.currentDocumentsRevision(TENDER_ID);
  const configVersion = analysisRuns.currentConfigVersion();
  const ids = {};
  for (const stage of stages) {
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

async function cleanup(db) {
  await db.queryRun('DELETE FROM analysis_active_runs WHERE tender_id = ?', TENDER_ID);
  await db.queryRun(
    `DELETE FROM review_decisions WHERE cluster_id IN (SELECT id FROM issue_clusters WHERE tender_id = ?)`,
    TENDER_ID,
  );
  await db.queryRun(
    `DELETE FROM review_decisions WHERE issue_id IN (SELECT id FROM issues WHERE tender_id = ?)`,
    TENDER_ID,
  );
  await db.queryRun(
    `DELETE FROM issue_cluster_items WHERE cluster_id IN (SELECT id FROM issue_clusters WHERE tender_id = ?)`,
    TENDER_ID,
  );
  for (const t of ['issue_clusters', 'draft_issues', 'issue_reviews', 'self_analysis_results',
    'analysis_signals', 'issues', 'tz_excluded_ranges', 'analysis_segments', 'analysis_runs']) {
    // eslint-disable-next-line no-await-in-loop
    await db.queryRun(`DELETE FROM ${t} WHERE tender_id = ?`, TENDER_ID);
  }
  await db.queryRun('DELETE FROM tender_stage_state WHERE tender_id = ?', TENDER_ID);
  await db.queryRun('DELETE FROM audit_log WHERE tender_id = ?', TENDER_ID);
}

before(async () => {
  if (OPTS.skip) return;
  const { runMigration } = require('../../db/migrate');
  await runMigration();
  const db = getDb();
  await cleanup(db);
  await db.queryRun('DELETE FROM tenders WHERE id = ?', TENDER_ID);
  await db.queryRun(
    'INSERT INTO tenders (id, title, status, created_at) VALUES (?, ?, ?, ?)',
    TENDER_ID, 'Неизменяемость снимков', 'draft', nowIso(),
  );
});

after(async () => {
  if (OPTS.skip) return;
  const db = getDb();
  await cleanup(db);
  await db.queryRun('DELETE FROM tenders WHERE id = ?', TENDER_ID);
  await closeDb();
});

// --- 1. Страж записи: completed и superseded прогоны неизменяемы ---------------

test('в completed (активный) прогон писать нельзя — ни стражем, ни через build', OPTS, async () => {
  const db = getDb();
  await cleanup(db);

  const runId = await analysisRuns.beginCandidateRun(TENDER_ID, { reason: 'test' });
  await addDraft(db, 'imm-d1', runId);
  await analysisRuns.activateRun(TENDER_ID, analysisRuns.SCOPE_PIPELINE, runId, {});

  // Страж: прямая проверка.
  await assert.rejects(
    () => analysisRuns.assertRunWritable(TENDER_ID, runId, { kind: 'pipeline' }),
    (err) => {
      assert.equal(err.code, 'RUN_NOT_WRITABLE');
      assert.equal(err.status, 409);
      assert.match(err.message, /завершён/);
      return true;
    },
  );

  // Через слой: build с явным runId активного снимка обязан упасть,
  // а строки снимка — остаться на месте.
  await assert.rejects(() => unified.buildDraftIssues(TENDER_ID, runId), /RUN_NOT_WRITABLE|запрещена/);
  const rows = await db.queryOne(
    'SELECT COUNT(*) AS c FROM draft_issues WHERE analysis_run_id = ?', runId,
  );
  assert.equal(Number(rows.c), 1, 'строки завершённого снимка не удаляются и не перезаписываются');
});

test('в архивный (superseded) прогон писать нельзя', OPTS, async () => {
  const db = getDb();
  await cleanup(db);

  const runOld = await analysisRuns.beginCandidateRun(TENDER_ID, { reason: 'test-old' });
  await addDraft(db, 'imm-old', runOld);
  await analysisRuns.activateRun(TENDER_ID, analysisRuns.SCOPE_PIPELINE, runOld, {});
  const runNew = await analysisRuns.beginCandidateRun(TENDER_ID, { reason: 'test-new' });
  await analysisRuns.activateRun(TENDER_ID, analysisRuns.SCOPE_PIPELINE, runNew, {}); // runOld → архив

  const archived = await db.queryOne('SELECT superseded_at FROM analysis_runs WHERE id = ?', runOld);
  assert.ok(archived.superseded_at, 'прежний снимок должен быть архивирован');

  await assert.rejects(
    () => analysisRuns.assertRunWritable(TENDER_ID, runOld, { kind: 'pipeline' }),
    (err) => {
      assert.equal(err.code, 'RUN_NOT_WRITABLE');
      assert.match(err.message, /архивирован/);
      return true;
    },
  );
  const rows = await db.queryOne('SELECT COUNT(*) AS c FROM draft_issues WHERE analysis_run_id = ?', runOld);
  assert.equal(Number(rows.c), 1, 'архив остаётся как был');
});

test('прогон другого тендера и несуществующий прогон — тоже отказ (fail-closed)', OPTS, async () => {
  const db = getDb();
  await cleanup(db);
  const runId = await analysisRuns.beginCandidateRun(TENDER_ID, { reason: 'test' });
  await assert.rejects(() => analysisRuns.assertRunWritable('other-tender', runId, {}), /другому тендеру/);
  await assert.rejects(() => analysisRuns.assertRunWritable(TENDER_ID, 'run-does-not-exist', {}), /не найден/);
  await assert.rejects(() => analysisRuns.assertRunWritable(TENDER_ID, null, {}), /RUN_ID_REQUIRED|без analysis_run_id/);
});

// --- 2. Одиночный build (debug) не меняет production-снимок --------------------

test('build без runId пишет в НОВЫЙ кандидат: активный снимок и указатель неизменны', OPTS, async () => {
  const db = getDb();
  await cleanup(db);

  // Действующий снимок с одной строкой.
  const active = await analysisRuns.beginCandidateRun(TENDER_ID, { reason: 'active' });
  await addDraft(db, 'imm-active-1', active, 'старый фрагмент');
  await analysisRuns.activateRun(TENDER_ID, analysisRuns.SCOPE_PIPELINE, active, {});

  const res = await unified.buildDraftIssues(TENDER_ID); // без runId — debug-путь
  const candidate = res.summary.run_id;

  assert.ok(candidate && candidate !== active, 'build обязан создать НОВЫЙ прогон-кандидат');
  assert.equal(
    await analysisRuns.getActivePipelineRunId(TENDER_ID), active,
    'указатель не переводится: production-снимок остаётся прежним',
  );
  const cand = await db.queryOne('SELECT status, superseded_at FROM analysis_runs WHERE id = ?', candidate);
  assert.equal(cand.status, 'running', 'кандидат не активируется одиночным build');
  assert.equal(cand.superseded_at, null);

  // Строки прежнего снимка не тронуты.
  const oldRows = await db.queryAll(
    'SELECT id, source_fragment FROM draft_issues WHERE analysis_run_id = ?', active,
  );
  assert.equal(oldRows.length, 1);
  assert.equal(oldRows[0].id, 'imm-active-1');
  assert.equal(oldRows[0].source_fragment, 'старый фрагмент');

  // Чтение по умолчанию отдаёт активный снимок, а не кандидата.
  const listedActive = await unified.listDraftIssues(TENDER_ID);
  assert.deepEqual(listedActive.map((r) => r.id), ['imm-active-1']);
  // Кандидата видно только явным run_id.
  const listedCandidate = await unified.listDraftIssues(TENDER_ID, { runId: candidate });
  assert.ok(listedCandidate.every((r) => r.analysis_run_id === candidate));
});

// --- 3. Сбой нового прогона сохраняет старый результат -------------------------

test('сбой нового прогона: указатель, кластеры и решения прежнего снимка сохраняются', OPTS, async () => {
  const db = getDb();
  await cleanup(db);
  await seedStageSnapshots(db); // валидные входы: manifest пройдёт

  // Прежний УСПЕШНЫЙ снимок: кластер + решение инженера.
  const good = await analysisRuns.beginCandidateRun(TENDER_ID, { reason: 'good' });
  await addDraft(db, 'imm-good-d', good);
  await addCluster(db, 'imm-good-c', good);
  await addClusterDecision(db, 'imm-good-dec', 'imm-good-c', good);
  await analysisRuns.activateRun(TENDER_ID, analysisRuns.SCOPE_PIPELINE, good, {});

  // Новый прогон: второй шаг падает (раннеры инъектируются).
  const runners = {
    draft_issues: async () => ({ summary: { draft_issues: 0 } }),
    critic: async () => { throw new Error('critic упал'); },
    clustering: async () => ({ summary: { clusters: 0 } }),
  };
  const report = await pipeline.runPipeline(TENDER_ID, { withSelfAnalysis: false }, runners);

  assert.equal(report.ok, false, 'прогон должен быть признан неуспешным');
  assert.equal(report.failed_step, 'critic');
  assert.equal(report.activated, false);

  // Указатель остался на прежнем снимке.
  assert.equal(await analysisRuns.getActivePipelineRunId(TENDER_ID), good, 'указатель не сдвинулся');
  const goodRun = await db.queryOne('SELECT status, superseded_at FROM analysis_runs WHERE id = ?', good);
  assert.equal(goodRun.status, 'completed');
  assert.equal(goodRun.superseded_at, null, 'прежний снимок НЕ архивирован провалившимся прогоном');

  // Данные и решение прежнего снимка целы.
  const clusters = await db.queryOne(
    'SELECT COUNT(*) AS c FROM issue_clusters WHERE analysis_run_id = ?', good,
  );
  assert.equal(Number(clusters.c), 1);
  const decision = await db.queryOne('SELECT decision, final_comment FROM review_decisions WHERE id = ?', 'imm-good-dec');
  assert.ok(decision, 'решение инженера не потеряно');
  assert.equal(decision.final_comment, 'решение инженера');

  // Провалившийся прогон помечен failed.
  const failedRun = await db.queryOne('SELECT status FROM analysis_runs WHERE id = ?', report.run_id);
  assert.equal(failedRun.status, 'failed');
});

test('успешный повторный прогон: новый снимок активируется, прежний архивируется (не удаляется)', OPTS, async () => {
  const db = getDb();
  await cleanup(db);
  await seedStageSnapshots(db);

  const first = await analysisRuns.beginCandidateRun(TENDER_ID, { reason: 'first' });
  await addCluster(db, 'imm-first-c', first);
  await analysisRuns.activateRun(TENDER_ID, analysisRuns.SCOPE_PIPELINE, first, {});

  const runners = {
    draft_issues: async () => ({ summary: {} }),
    critic: async () => ({ summary: {} }),
    clustering: async () => ({ summary: { clusters: 1 } }),
  };
  const report = await pipeline.runPipeline(TENDER_ID, { withSelfAnalysis: false }, runners);

  assert.equal(report.ok, true);
  assert.equal(report.activated, true);
  assert.equal(await analysisRuns.getActivePipelineRunId(TENDER_ID), report.run_id);
  const prev = await db.queryOne('SELECT status, superseded_at FROM analysis_runs WHERE id = ?', first);
  assert.equal(prev.status, 'completed');
  assert.ok(prev.superseded_at, 'прежний снимок архивирован');
  const stillThere = await db.queryOne('SELECT COUNT(*) AS c FROM issue_clusters WHERE analysis_run_id = ?', first);
  assert.equal(Number(stillThere.c), 1, 'строки архивного снимка не удаляются');
});

// --- 4. Сброс стадии не удаляет историю ---------------------------------------

test('resetStage: снимает указатели и архивирует прогоны, но история и решения остаются', OPTS, async () => {
  const db = getDb();
  await cleanup(db);
  const stageRuns = await seedStageSnapshots(db);
  await addStageIssue(db, 'imm-i2', stageRuns[2], 2);
  await addStageIssue(db, 'imm-i3', stageRuns[3], 3);
  await db.queryRun(
    `INSERT INTO review_decisions (id, issue_id, decision, final_comment, decided_at)
     VALUES (?, ?, 'accept', 'решение по стадии 2', ?)`,
    'imm-dec-i2', 'imm-i2', nowIso(),
  );
  // Производный снимок конвейера поверх этих стадий.
  const pipelineRun = await analysisRuns.beginCandidateRun(TENDER_ID, { reason: 'derived' });
  await addCluster(db, 'imm-derived-c', pipelineRun);
  await analysisRuns.activateRun(TENDER_ID, analysisRuns.SCOPE_PIPELINE, pipelineRun, {});
  await engine.getStageState(TENDER_ID); // строка workflow-состояния

  const state = await engine.resetStage(TENDER_ID, 2);

  // Указатели стадий ≥ 2 сняты, стадия 1 осталась актуальной.
  assert.equal(await analysisRuns.getActiveStageRunId(TENDER_ID, 1), stageRuns[1], 'стадия 1 не сброшена');
  for (const s of [2, 3, 4]) {
    // eslint-disable-next-line no-await-in-loop
    assert.equal(await analysisRuns.getActiveStageRunId(TENDER_ID, s), null, `указатель стадии ${s} снят`);
  }
  assert.equal(await analysisRuns.getActivePipelineRunId(TENDER_ID), null, 'указатель pipeline снят');

  // История НЕ удалена: прогоны, issues, сигналы и решения на месте.
  const runs = await db.queryOne(
    `SELECT COUNT(*) AS c FROM analysis_runs WHERE tender_id = ? AND kind = 'stage' AND stage >= 2`,
    TENDER_ID,
  );
  assert.equal(Number(runs.c), 3, 'analysis_runs сброшенных стадий не удаляются');
  const archived = await db.queryOne(
    `SELECT COUNT(*) AS c FROM analysis_runs
      WHERE tender_id = ? AND kind = 'stage' AND stage >= 2 AND superseded_at IS NOT NULL`,
    TENDER_ID,
  );
  assert.equal(Number(archived.c), 3, 'прогоны сброшенных стадий архивированы');
  const issues = await db.queryOne(
    'SELECT COUNT(*) AS c FROM issues WHERE tender_id = ? AND analysis_stage >= 2', TENDER_ID,
  );
  assert.equal(Number(issues.c), 2, 'issues сброшенных стадий не удаляются');
  assert.ok(
    await db.queryOne('SELECT id FROM review_decisions WHERE id = ?', 'imm-dec-i2'),
    'решение инженера не удаляется сбросом стадии',
  );
  assert.ok(
    await db.queryOne('SELECT id FROM issue_clusters WHERE id = ?', 'imm-derived-c'),
    'кластеры производного снимка остаются в БД (снят только указатель)',
  );

  // Workflow-состояние сброшено.
  assert.equal(state.stage2_status, 'open');
  assert.equal(state.stage3_status, 'locked');
  assert.equal(Number(state.current_stage), 2);

  // Событие в журнале аудита.
  const entry = await db.queryOne(
    `SELECT action, category, meta FROM audit_log
      WHERE tender_id = ? AND action = 'stage.reset' ORDER BY ts DESC LIMIT 1`,
    TENDER_ID,
  );
  assert.ok(entry, 'сброс стадии обязан попасть в журнал аудита');
  assert.equal(entry.category, 'analysis');
  const meta = JSON.parse(entry.meta);
  assert.equal(meta.from_stage, 2);
  assert.equal(meta.archived_stage_runs.length, 3);
  assert.equal(meta.cleared_pipeline_pointer, pipelineRun);
});

// --- 5. Admin purge — единственное физическое удаление -------------------------

test('purge: по умолчанию dry-run, актуальный снимок не удаляется никогда', OPTS, async () => {
  const db = getDb();
  await cleanup(db);

  const runOld = await analysisRuns.beginCandidateRun(TENDER_ID, { reason: 'old' });
  await addDraft(db, 'imm-purge-old', runOld);
  await analysisRuns.activateRun(TENDER_ID, analysisRuns.SCOPE_PIPELINE, runOld, {});
  const runMid = await analysisRuns.beginCandidateRun(TENDER_ID, { reason: 'mid' });
  await addDraft(db, 'imm-purge-mid', runMid);
  await analysisRuns.activateRun(TENDER_ID, analysisRuns.SCOPE_PIPELINE, runMid, {});
  const runActive = await analysisRuns.beginCandidateRun(TENDER_ID, { reason: 'active' });
  await addDraft(db, 'imm-purge-active', runActive);
  await analysisRuns.activateRun(TENDER_ID, analysisRuns.SCOPE_PIPELINE, runActive, {});

  // Без confirm — только план.
  const dry = await purge.purgeTenderHistory(TENDER_ID, { keepLast: 0 });
  assert.equal(dry.dry_run, true);
  assert.equal(dry.deleted, false);
  assert.equal(
    Number((await db.queryOne('SELECT COUNT(*) AS c FROM analysis_runs WHERE tender_id = ?', TENDER_ID)).c),
    3, 'dry-run ничего не удаляет',
  );
  const planned = dry.runs_to_purge.map((r) => r.id);
  assert.ok(!planned.includes(runActive), 'актуальный снимок не может попасть под удаление');

  // С confirm — удаляются только архивные.
  const done = await purge.purgeTenderHistory(TENDER_ID, { keepLast: 0, confirm: TENDER_ID });
  assert.equal(done.deleted, true);
  assert.equal(done.runs_deleted, 2);
  const left = await db.queryAll('SELECT id FROM analysis_runs WHERE tender_id = ?', TENDER_ID);
  assert.deepEqual(left.map((r) => r.id), [runActive], 'остался только актуальный снимок');
  const drafts = await db.queryAll('SELECT id FROM draft_issues WHERE tender_id = ?', TENDER_ID);
  assert.deepEqual(drafts.map((r) => r.id), ['imm-purge-active'], 'строки архивных снимков удалены');
  assert.equal(
    await analysisRuns.getActivePipelineRunId(TENDER_ID), runActive, 'указатель не тронут',
  );

  // Событие удаления — в журнале аудита.
  const entry = await db.queryOne(
    `SELECT action, category FROM audit_log WHERE tender_id = ? AND action = 'admin.purge.runs'
      ORDER BY ts DESC LIMIT 1`,
    TENDER_ID,
  );
  assert.ok(entry, 'purge обязан попасть в журнал аудита');
  assert.equal(entry.category, 'admin');
});

test('purge с keep_last: последний архив сохраняется (основа переноса решений)', OPTS, async () => {
  const db = getDb();
  await cleanup(db);
  const a = await analysisRuns.beginCandidateRun(TENDER_ID, { reason: 'a' });
  await analysisRuns.activateRun(TENDER_ID, analysisRuns.SCOPE_PIPELINE, a, {});
  const b = await analysisRuns.beginCandidateRun(TENDER_ID, { reason: 'b' });
  await analysisRuns.activateRun(TENDER_ID, analysisRuns.SCOPE_PIPELINE, b, {});
  const c = await analysisRuns.beginCandidateRun(TENDER_ID, { reason: 'c' });
  await analysisRuns.activateRun(TENDER_ID, analysisRuns.SCOPE_PIPELINE, c, {});

  const res = await purge.purgeTenderHistory(TENDER_ID, { keepLast: 1, confirm: TENDER_ID });
  assert.equal(res.runs_deleted, 1, 'удалён только самый старый архив');
  const left = new Set((await db.queryAll('SELECT id FROM analysis_runs WHERE tender_id = ?', TENDER_ID)).map((r) => r.id));
  assert.ok(left.has(c), 'актуальный на месте');
  assert.ok(left.has(b), 'последний архив сохранён (keep_last=1)');
  assert.ok(!left.has(a));
});
