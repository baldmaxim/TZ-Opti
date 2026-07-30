'use strict';

// Integration: СОГЛАСОВАННЫЕ ВЕРСИИ ТЗ (tz_agreed_versions) через Postgres.
//
// Что защищаем:
//   • createAgreedVersion строит версию из решений АКТИВНОГО pipeline-прогона:
//     delete-фрагмент вырезан из md_text, снимок applied_decisions сохранён;
//   • активация версии меняет currentDocumentsRevision (вход следующего раунда),
//     getTzText отдаёт текст версии с её собственной ревизией;
//   • снимок неизменяем: смена живых решений после создания версию не трогает;
//   • архив активной версии возвращает анализ на оригинальный .md;
//   • одна active на тендер: активация второй архивирует первую.
//
//   npm run test:integration    — без TEST_DATABASE_URL тесты SKIP
//   npm run verify:integration  — без TEST_DATABASE_URL тесты ПАДАЮТ

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { dbTestOptions, getDb, closeDb } = require('../helpers/testDb');
const analysisRuns = require('../../services/analysisRuns/analysisRunsService');
const agreed = require('../../services/agreedVersion/agreedVersionService');
const tz = require('../../services/tzActiveTextService');

const OPTS = dbTestOptions();
const TENDER_ID = 'agreed-version-tender';

const nowIso = () => new Date().toISOString();

const TZ_MD = `# 1. Объём работ

Подрядчик выполняет ежедневную уборку строительной площадки за свой счёт.

Гарантийный срок составляет 10 лет с момента подписания акта.
`;

async function seedTenderWithDoc(db) {
  await db.queryRun(
    'INSERT INTO tenders (id, title, status, created_at) VALUES (?, ?, ?, ?)',
    TENDER_ID, 'Согласованные версии', 'draft', nowIso(),
  );
  await db.queryRun(
    `INSERT INTO documents (id, tender_id, doc_type, name, file_path, uploaded_at, extracted_text, processing_status)
     VALUES ('agr-doc-md', ?, 'tz', 'ТЗ.md', '/tmp/tz.md', ?, ?, 'extracted')`,
    TENDER_ID, nowIso(), TZ_MD,
  );
}

async function seedPipelineWithDecision(db, {
  clusterId = 'agr-cluster-1', decisionKind = 'delete', fragment = 'за свой счёт',
} = {}) {
  const runId = await analysisRuns.beginCandidateRun(TENDER_ID, { reason: 'agreed-version-test' });
  await db.queryRun(
    `INSERT INTO issue_clusters (id, tender_id, analysis_run_id, tz_clause, cluster_title,
       merged_basis, merged_recommendation, overall_criticality, show_to_engineer,
       final_problem_type, semantic_bucket, cluster_key, item_count, paragraph_index, created_at,
       representative_fragment, evidence_fragments, occurrence_count)
     VALUES (?, ?, ?, 'п. 1.1', 'Кластер', 'основание', 'рекомендация', 'high', 1,
       'не_учтено_в_кп', 'price|modify', 'k1', 1, 1, ?, ?, ?, 1)`,
    clusterId, TENDER_ID, runId, nowIso(), fragment,
    JSON.stringify([{ paragraph_index: 1, fragment }]),
  );
  await db.queryRun(
    `INSERT INTO review_decisions (id, issue_id, cluster_id, analysis_run_id, cluster_key,
       decision, final_comment, decided_at)
     VALUES (?, NULL, ?, ?, 'k1', ?, 'решение инженера', ?)`,
    `agr-dec-${clusterId}`, clusterId, runId, decisionKind, nowIso(),
  );
  await analysisRuns.activateRun(TENDER_ID, analysisRuns.SCOPE_PIPELINE, runId, {});
  return runId;
}

async function cleanup(db) {
  await db.queryRun('DELETE FROM analysis_active_runs WHERE tender_id = ?', TENDER_ID);
  await db.queryRun(
    `DELETE FROM review_decisions WHERE cluster_id IN (SELECT id FROM issue_clusters WHERE tender_id = ?)`,
    TENDER_ID,
  );
  for (const t of ['issue_clusters', 'tz_agreed_versions', 'analysis_runs', 'documents', 'audit_log']) {
    // eslint-disable-next-line no-await-in-loop
    await db.queryRun(`DELETE FROM ${t} WHERE tender_id = ?`, TENDER_ID);
  }
  await db.queryRun('DELETE FROM tenders WHERE id = ?', TENDER_ID);
}

before(async () => {
  if (OPTS.skip) return;
  const { runMigration } = require('../../db/migrate');
  await runMigration();
  const db = getDb();
  await cleanup(db);
  await seedTenderWithDoc(db);
});

after(async () => {
  if (OPTS.skip) return;
  await cleanup(getDb());
  await closeDb();
});

test('полный круг: создать → активировать → новая ревизия входа → архив', OPTS, async () => {
  const db = getDb();
  await seedPipelineWithDecision(db);

  const baseRevision = await analysisRuns.currentDocumentsRevision(TENDER_ID);

  // 1. Создание: delete-фрагмент вырезан, снимок решений сохранён.
  const version = await agreed.createAgreedVersion(TENDER_ID, {});
  assert.equal(version.status, 'draft');
  assert.equal(version.version_no, 1);
  assert.equal(version.applied_decisions.length, 1);
  assert.equal(version.build_report.applied, 1);
  const full = await agreed.getVersion(TENDER_ID, version.id, { withText: true });
  assert.ok(!full.md_text.includes('за свой счёт'), 'фрагмент решения delete вырезан');
  assert.ok(full.md_text.includes('# 1. Объём работ'), 'md-разметка сохранена');

  // Draft не влияет на вход анализа.
  assert.equal(await analysisRuns.currentDocumentsRevision(TENDER_ID), baseRevision);
  const beforeActivation = await tz.getTzText(TENDER_ID);
  assert.ok(beforeActivation.rawText.includes('за свой счёт'), 'draft не подменяет текст');

  // 2. Активация: вход анализа = текст версии, ревизия набора изменилась.
  await agreed.activateVersion(TENDER_ID, version.id, {});
  const revisionAfter = await analysisRuns.currentDocumentsRevision(TENDER_ID);
  assert.notEqual(revisionAfter, baseRevision, 'активация версии = новая ревизия документов');

  const active = await tz.getTzText(TENDER_ID);
  assert.ok(!active.rawText.includes('за свой счёт'), 'анализ читает текст версии');
  assert.equal(active.document.agreed_version_id, version.id);
  assert.equal(active.revisionId, version.revision_id, 'ревизия версии считается одинаково при записи и чтении');
  assert.equal(active.document.base_document_id, 'agr-doc-md', 'FK-база — исходный .md');

  // 3. Снимок неизменяем: подмена живого решения не меняет applied_decisions.
  await db.queryRun(
    `UPDATE review_decisions SET decision = 'accept' WHERE cluster_id = 'agr-cluster-1'`,
  );
  const reread = await agreed.getVersion(TENDER_ID, version.id);
  assert.equal(reread.applied_decisions[0].decision, 'delete', 'снимок фиксирует решение на момент создания');

  // 4. Архив: вход анализа возвращается на оригинал.
  await agreed.archiveVersion(TENDER_ID, version.id, {});
  const back = await tz.getTzText(TENDER_ID);
  assert.ok(back.rawText.includes('за свой счёт'));
  assert.equal(await analysisRuns.currentDocumentsRevision(TENDER_ID), baseRevision);
});

test('одна active на тендер: активация второй версии архивирует первую (цепочка)', OPTS, async () => {
  const db = getDb();

  // Вернуть живое решение (тест выше подменял его для проверки снимка).
  await db.queryRun(
    `UPDATE review_decisions SET decision = 'delete' WHERE cluster_id = 'agr-cluster-1'`,
  );

  // Первая версия снова активна (база — оригинал: активной нет после архива).
  const v1 = await agreed.createAgreedVersion(TENDER_ID, {});
  await agreed.activateVersion(TENDER_ID, v1.id, {});

  // Второй раунд: новый прогон с решением по другому месту.
  await db.queryRun('DELETE FROM analysis_active_runs WHERE tender_id = ? AND scope = ?', TENDER_ID, analysisRuns.SCOPE_PIPELINE);
  await seedPipelineWithDecision(db, {
    clusterId: 'agr-cluster-2', decisionKind: 'delete', fragment: '10 лет',
  });
  const v2 = await agreed.createAgreedVersion(TENDER_ID, {});
  assert.equal(v2.version_no, v1.version_no + 1);
  assert.equal(v2.base_agreed_version_id, v1.id, 'вторая версия строится ОТ первой');

  const v2full = await agreed.getVersion(TENDER_ID, v2.id, { withText: true });
  assert.ok(!v2full.md_text.includes('за свой счёт'), 'правка первой версии сохранена в цепочке');
  assert.ok(!v2full.md_text.includes('10 лет'), 'правка второй версии применена');

  await agreed.activateVersion(TENDER_ID, v2.id, {});
  const rows = await db.queryAll(
    `SELECT id, status FROM tz_agreed_versions WHERE tender_id = ? ORDER BY version_no`, TENDER_ID,
  );
  assert.equal(rows.filter((r) => r.status === 'active').length, 1, 'ровно одна active');
  assert.equal(rows.find((r) => r.id === v1.id).status, 'archived');
  assert.equal(rows.find((r) => r.id === v2.id).status, 'active');

  const text = await tz.getTzText(TENDER_ID);
  assert.equal(text.document.agreed_version_id, v2.id);
});
