'use strict';

// Integration: жёсткий гейт готовности рецензии на живом PostgreSQL.
//   npm run test:integration    — без TEST_DATABASE_URL тесты SKIP
//   npm run verify:integration  — без TEST_DATABASE_URL тесты ПАДАЮТ
//
// Защищаемый контракт:
//   • незавершённая рецензия (нерешённые кластеры рабочего списка) блокирует
//     создание согласованной версии и даёт export_allowed=false;
//   • решение ВСЕХ кластеров (в т.ч. reject) открывает экспорт;
//   • пустой список кластерных решений НЕ включает legacy issue-путь —
//     legacy только явным source='issues';
//   • смена документов после сборки помечает снимок stale и снова закрывает гейт.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { dbTestOptions, getDb, closeDb } = require('../helpers/testDb');
const analysisRuns = require('../../services/analysisRuns/analysisRunsService');
const readiness = require('../../services/review/reviewReadinessService');
const exportSvc = require('../../services/exportService');
const agreedVersions = require('../../services/agreedVersion/agreedVersionService');
const { newId, nowIso } = require('../../utils/ids');

const OPTS = dbTestOptions();
const TENDER_ID = 'review-readiness-int-tender';

const TZ_MD = '# ТЗ\n## 1. Объём\nПодрядчик выполняет монолитные работы.\n';

let pipelineRunId = null;

async function insertCluster(db, id, { show = 1 } = {}) {
  await db.queryRun(
    `INSERT INTO issue_clusters (id, tender_id, analysis_run_id, cluster_title, verdict, show_to_engineer, created_at)
     VALUES (?, ?, ?, ?, 'publish', ?, ?)`,
    id, TENDER_ID, pipelineRunId, `Кластер ${id}`, show, nowIso(),
  );
}

async function decide(db, clusterId, decision) {
  await db.queryRun(
    `INSERT INTO review_decisions (id, cluster_id, analysis_run_id, decision, decided_at)
     VALUES (?, ?, ?, ?, ?)`,
    newId(), clusterId, pipelineRunId, decision, nowIso(),
  );
}

before(async () => {
  if (OPTS.skip) return;
  const { runMigration } = require('../../db/migrate');
  await runMigration();
  const db = getDb();
  await db.queryRun('DELETE FROM tenders WHERE id = ?', TENDER_ID);
  // review_decisions не каскадятся с тендером (FK только на issues) — чистим
  // решения прошлых прогонов теста по нашим статичным cluster_id.
  await db.queryRun(`DELETE FROM review_decisions WHERE cluster_id LIKE 'rr-%'`);
  await db.queryRun(
    'INSERT INTO tenders (id, title, status, created_at) VALUES (?, ?, ?, ?)',
    TENDER_ID, 'Готовность рецензии: integration-тест', 'draft', nowIso(),
  );
  await db.queryRun(
    `INSERT INTO documents (id, tender_id, doc_type, name, file_path, uploaded_at, extracted_text, processing_status)
     VALUES (?, ?, 'tz', 'tz.md', 'virtual://tz.md', ?, ?, 'extracted')`,
    'readiness-tz-md', TENDER_ID, nowIso(), TZ_MD,
  );

  // Активный pipeline-снимок с двумя кластерами рабочего списка и одним скрытым.
  pipelineRunId = await analysisRuns.beginCandidateRun(TENDER_ID, { reason: 'readiness.test' });
  await insertCluster(db, 'rr-a');
  await insertCluster(db, 'rr-b');
  await insertCluster(db, 'rr-hidden', { show: 0 });
  await analysisRuns.activateRun(TENDER_ID, analysisRuns.SCOPE_PIPELINE, pipelineRunId, {});
});

after(async () => {
  if (OPTS.skip) return;
  const db = getDb();
  await db.queryRun('DELETE FROM tenders WHERE id = ?', TENDER_ID).catch(() => {});
  await closeDb();
});

test('незавершённая рецензия: export_allowed=false, создание версии отклоняется 409', OPTS, async () => {
  const r = await readiness.getReadiness(TENDER_ID);
  assert.equal(r.pipeline_run_id, pipelineRunId);
  assert.equal(r.total_clusters, 2, 'скрытый кластер решения не требует');
  assert.equal(r.unresolved_clusters, 2);
  assert.equal(r.export_allowed, false);

  await assert.rejects(
    () => agreedVersions.createAgreedVersion(TENDER_ID),
    (e) => e.code === 'REVIEW_NOT_READY' && e.status === 409 && e.details.unresolved_clusters === 2,
  );
});

test('пустые кластерные решения НЕ включают legacy: source=clusters, legacy — только явно', OPTS, async () => {
  const csv = await exportSvc.exportCsv(TENDER_ID, {});
  assert.equal(csv.source, 'clusters', 'авто-fallback на issues убран');
  const legacy = await exportSvc.exportCsv(TENDER_ID, { source: 'issues' });
  assert.equal(legacy.source, 'issues', 'legacy — только явным запросом');
});

test('решение всех кластеров (в т.ч. reject) открывает экспорт', OPTS, async () => {
  const db = getDb();
  await decide(db, 'rr-a', 'accept');
  let r = await readiness.getReadiness(TENDER_ID);
  assert.equal(r.export_allowed, false, 'остался один нерешённый');

  await decide(db, 'rr-b', 'reject');
  r = await readiness.getReadiness(TENDER_ID);
  assert.equal(r.decided_clusters, 2);
  assert.equal(r.rejected_clusters, 1);
  assert.equal(r.accepted_clusters, 1);
  assert.equal(r.unresolved_clusters, 0);
  assert.equal(r.export_allowed, true);
  await assert.doesNotReject(() => readiness.assertReviewReady(TENDER_ID));
});

test('смена документов после сборки: снимок stale, гейт снова закрыт', OPTS, async () => {
  const db = getDb();
  await db.queryRun(
    'UPDATE documents SET extracted_text = ? WHERE id = ?',
    `${TZ_MD}\n## 2. Дополнение\nНовый раздел.\n`, 'readiness-tz-md',
  );
  const r = await readiness.getReadiness(TENDER_ID);
  assert.equal(r.pipeline_stale, true);
  assert.equal(r.export_allowed, false);
  await assert.rejects(
    () => readiness.assertReviewReady(TENDER_ID, 'экспорт .docx'),
    /прежней ревизии документов/,
  );
});
