'use strict';

// Согласованные версии ТЗ (tz_agreed_versions) — БД-слой над чистым билдером
// agreedTextBuilder.js.
//
// Жизненный цикл: createAgreedVersion (draft, из решений АКТИВНОГО pipeline-
// прогона) → activateVersion (архивирует прежнюю active; активная версия
// становится ВХОДОМ следующего раунда анализа через getTzSourceDocument и
// участвует в currentDocumentsRevision) → archiveVersion.
//
// Снимок applied_decisions НЕИЗМЕНЯЕМ: он фиксирует, какие решения (и в каком
// виде) легли в версию. Экспорт конкретной версии идёт от снимка, а не от
// живых review_decisions.

const db = require('../../db/connection');
const { newId, nowIso } = require('../../utils/ids');
const { badRequest, notFound } = require('../../utils/errors');
const { parseMdToBlocks } = require('../mdParser');
const { getTzMdDocument, computeRevisionId } = require('../tzActiveTextService');
const analysisRuns = require('../analysisRuns/analysisRunsService');
const { buildAgreedText } = require('./agreedTextBuilder');
const audit = require('../audit/auditService');
const { assertReviewReady } = require('../review/reviewReadinessService');

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_e) { return fallback; }
}

function rowToVersion(row, { withText = false } = {}) {
  if (!row) return null;
  const out = {
    id: row.id,
    tender_id: row.tender_id,
    version_no: Number(row.version_no),
    base_document_id: row.base_document_id,
    base_revision_id: row.base_revision_id,
    base_agreed_version_id: row.base_agreed_version_id,
    analysis_run_id: row.analysis_run_id,
    revision_id: row.revision_id,
    status: row.status,
    created_at: row.created_at,
    created_by: row.created_by,
    applied_decisions: parseJson(row.applied_decisions, []),
    build_report: parseJson(row.build_report, null),
  };
  if (withText) out.md_text = row.md_text;
  return out;
}

// Синтетический «документ» версии — для computeRevisionId / getTzText /
// currentDocumentsRevision. Форма совпадает со строкой documents в местах,
// которые читают стадии (id, version, extracted_text, name, doc_type).
function versionAsDocument(row) {
  if (!row) return null;
  return {
    id: `agr:${row.id}`,
    tender_id: row.tender_id,
    doc_type: 'tz',
    name: `ТЗ (согласованная версия ${row.version_no}).md`,
    version: `agreed-${row.version_no}`,
    extracted_text: row.md_text || '',
    uploaded_at: row.created_at,
    processing_status: 'extracted',
    agreed_version_id: row.id,
    base_document_id: row.base_document_id || null,
  };
}

async function getActiveAgreedVersion(tenderId, { withText = false } = {}) {
  const row = await db.queryOne(
    `SELECT * FROM tz_agreed_versions WHERE tender_id = ? AND status = 'active'
     ORDER BY version_no DESC LIMIT 1`,
    tenderId,
  );
  if (!row) return null;
  return withText ? row : rowToVersion(row);
}

// Строка активной версии КАК ДОКУМЕНТ (для механики ревизий). null — версии нет.
async function getActiveAgreedDocument(tenderId) {
  const row = await getActiveAgreedVersion(tenderId, { withText: true });
  return row ? versionAsDocument(row) : null;
}

// Primary draft_issue по списку кластеров → Map<cluster_id, draft_issue-row>
// (та же выборка, что в clusterReviewService — функция там приватная).
async function loadPrimaryDrafts(clusterIds) {
  const map = new Map();
  if (!clusterIds.length) return map;
  const ph = clusterIds.map(() => '?').join(', ');
  const rows = await db.queryAll(
    `SELECT ci.cluster_id, d.*
       FROM issue_cluster_items ci
       JOIN draft_issues d ON d.id = ci.draft_issue_id
      WHERE ci.cluster_id IN (${ph}) AND ci.item_role = 'primary'`,
    ...clusterIds,
  );
  for (const r of rows) map.set(r.cluster_id, r);
  return map;
}

// Решения активного pipeline-прогона в формате снимка версии: полный контекст
// для билдера (вхождения) + всё, что нужно экспорту (issue-поля primary).
async function loadDecisionsForBuild(tenderId) {
  const rid = await analysisRuns.getActivePipelineRunId(tenderId);
  if (!rid) return { runId: null, decisions: [] };
  const rows = await db.queryAll(
    `SELECT c.id AS cluster_id, c.cluster_key, c.cluster_title, c.tz_clause,
            c.paragraph_index, c.representative_fragment, c.evidence_fragments,
            c.final_problem_type,
            rd.decision, rd.edited_redaction, rd.final_comment, rd.target_text
       FROM issue_clusters c
       JOIN review_decisions rd ON rd.cluster_id = c.id
      WHERE c.tender_id = ? AND c.analysis_run_id = ? AND rd.decision <> 'reject'
      ORDER BY c.paragraph_index ASC NULLS LAST, c.created_at ASC`,
    tenderId, rid,
  );
  if (!rows.length) return { runId: rid, decisions: [] };
  const primaries = await loadPrimaryDrafts(rows.map((r) => r.cluster_id));
  return {
    runId: rid,
    decisions: rows.map((r) => {
      const primary = primaries.get(r.cluster_id) || {};
      return {
        cluster_id: r.cluster_id,
        cluster_key: r.cluster_key || null,
        cluster_title: r.cluster_title || null,
        decision: r.decision,
        target_text: r.target_text || null,
        edited_redaction: r.edited_redaction || null,
        final_comment: r.final_comment || null,
        suggested_redaction: primary.suggested_redaction || null,
        representative_fragment: r.representative_fragment || primary.source_fragment || null,
        paragraph_index: r.paragraph_index != null ? r.paragraph_index : (primary.paragraph_index ?? null),
        tz_clause: r.tz_clause || primary.tz_clause || null,
        problem_type: r.final_problem_type || primary.problem_type || null,
        evidence_fragments: parseJson(r.evidence_fragments, []),
      };
    }),
  };
}

// Создать версию (draft) из ТЕКУЩИХ решений активного прогона.
// База — активная agreed version (цепочка), иначе оригинальный .md.
async function createAgreedVersion(tenderId, { actor = null, requestId = null } = {}) {
  // ЖЁСТКИЙ ГЕЙТ: версия материализует решения рецензии — из незавершённой
  // рецензии (нерешённые кластеры / неразобранный carry-over / устаревший
  // снимок) её строить нельзя (409 REVIEW_NOT_READY с отчётом готовности).
  await assertReviewReady(tenderId, 'создание согласованной версии');
  const activeVersionRow = await getActiveAgreedVersion(tenderId, { withText: true });
  let baseText;
  let baseDocumentId = null;
  let baseRevisionId = null;
  let baseAgreedVersionId = null;

  if (activeVersionRow) {
    baseText = activeVersionRow.md_text || '';
    baseAgreedVersionId = activeVersionRow.id;
    baseRevisionId = activeVersionRow.revision_id;
    baseDocumentId = activeVersionRow.base_document_id;
  } else {
    const doc = await getTzMdDocument(tenderId);
    if (!doc) throw badRequest('Загрузите .md-копию ТЗ — согласованная версия строится от неё.');
    baseText = doc.extracted_text || '';
    baseDocumentId = doc.id;
    baseRevisionId = computeRevisionId(doc);
  }

  const { runId, decisions } = await loadDecisionsForBuild(tenderId);
  if (!runId) throw badRequest('Нет актуального итога анализа — сформируйте кластеры (шаг «Рецензия»).');
  if (!decisions.length) throw badRequest('Нет ни одного решения инженера — согласованная версия не отличалась бы от базы.');

  const blocks = await parseMdToBlocks(baseText);
  const { mdText, report } = buildAgreedText({ rawMd: baseText, blocks, decisions });

  const id = newId();
  const createdAt = nowIso();
  const row = await db.transaction(async (tx) => {
    const last = await tx.queryOne(
      'SELECT COALESCE(MAX(version_no), 0) AS n FROM tz_agreed_versions WHERE tender_id = ?',
      tenderId,
    );
    const versionNo = Number((last && last.n) || 0) + 1;
    const revisionId = computeRevisionId({
      id: `agr:${id}`, version: `agreed-${versionNo}`, extracted_text: mdText,
    });
    await tx.queryRun(
      `INSERT INTO tz_agreed_versions (
         id, tender_id, version_no, base_document_id, base_revision_id, base_agreed_version_id,
         analysis_run_id, applied_decisions, build_report, md_text, revision_id,
         status, created_at, created_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
      id, tenderId, versionNo, baseDocumentId, baseRevisionId, baseAgreedVersionId,
      runId, JSON.stringify(decisions), JSON.stringify(report), mdText, revisionId,
      createdAt, (actor && actor.subject) || null,
    );
    return tx.queryOne('SELECT * FROM tz_agreed_versions WHERE id = ?', id);
  });

  await audit.record({
    requestId,
    tenantId: actor && actor.tenantId,
    actorSub: actor && actor.subject,
    action: 'agreed_version.create', category: 'decision', outcome: 'allowed',
    tenderId, resourceType: 'agreed_version', resourceId: id,
    meta: {
      version_no: Number(row.version_no), analysis_run_id: runId,
      decisions: decisions.length,
      applied: report.applied, skipped: report.skipped, failed: report.failed, conflicts: report.conflicts,
    },
  }).catch(() => {});

  return rowToVersion(row);
}

// Снимок решений → строки экспорта (формат loadClusterDecisions:
// { issue, decision_kind, final_comment, edited_redaction, target_text }).
// Чистая функция: экспорт версии идёт от СНИМКА, а не от живых решений.
function snapshotToExportRows(applied) {
  return (applied || [])
    .filter((d) => d && d.decision && d.decision !== 'reject')
    .map((d) => ({
      issue: {
        id: d.cluster_id || null,
        analysis_stage: null,
        cluster_id: d.cluster_id || null,
        source_fragment: d.representative_fragment || null,
        source_clause: d.tz_clause || null,
        paragraph_index: d.paragraph_index ?? null,
        problem_type: d.problem_type || null,
        suggested_action: null,
        suggested_redaction: d.suggested_redaction || null,
        review_comment: null,
      },
      decision_kind: d.decision,
      final_comment: d.final_comment || null,
      edited_redaction: d.edited_redaction || d.suggested_redaction || null,
      target_text: d.target_text || null,
    }));
}

// Решения ВСЕЙ цепочки версии (оригинал → … → версия) в формате экспорта.
// docx-экспорт применяет их к оригинальному .docx: track changes показывают
// путь «оригинал → согласованная версия». Решения раунда 2, сделанные по
// тексту, ВСТАВЛЕННОМУ правками раунда 1, в оригинале не найдутся — quoteLocator
// честно отдаст их Word-комментарием (status='fallback').
async function loadExportDecisions(tenderId, versionId) {
  const chain = [];
  let cur = await db.queryOne(
    'SELECT * FROM tz_agreed_versions WHERE id = ? AND tender_id = ?', versionId, tenderId,
  );
  if (!cur) throw notFound('Согласованная версия не найдена');
  const target = cur;
  while (cur) {
    chain.unshift(cur); // от корня к вершине: правки ранних раундов применяются первыми
    cur = cur.base_agreed_version_id
      ? await db.queryOne(
        'SELECT * FROM tz_agreed_versions WHERE id = ? AND tender_id = ?',
        cur.base_agreed_version_id, tenderId,
      )
      : null;
  }
  const rows = chain.flatMap((v) => snapshotToExportRows(parseJson(v.applied_decisions, [])));
  return { version: rowToVersion(target), rows, chain_length: chain.length };
}

async function getVersion(tenderId, versionId, { withText = false } = {}) {
  const row = await db.queryOne(
    'SELECT * FROM tz_agreed_versions WHERE id = ? AND tender_id = ?',
    versionId, tenderId,
  );
  if (!row) throw notFound('Согласованная версия не найдена');
  return rowToVersion(row, { withText });
}

async function listVersions(tenderId) {
  const rows = await db.queryAll(
    `SELECT id, tender_id, version_no, base_document_id, base_revision_id, base_agreed_version_id,
            analysis_run_id, revision_id, status, created_at, created_by, build_report
       FROM tz_agreed_versions WHERE tender_id = ? ORDER BY version_no DESC`,
    tenderId,
  );
  return rows.map((r) => rowToVersion(r));
}

// Активация: одна active на тендер — прежняя уходит в archived в той же транзакции.
// Активная версия меняет currentDocumentsRevision → следующая production-сборка
// и стадии пойдут против новой ревизии (manifest это словит штатно).
async function activateVersion(tenderId, versionId, { actor = null, requestId = null } = {}) {
  const row = await db.queryOne(
    'SELECT * FROM tz_agreed_versions WHERE id = ? AND tender_id = ?', versionId, tenderId,
  );
  if (!row) throw notFound('Согласованная версия не найдена');
  if (row.status === 'active') return rowToVersion(row);
  // Активация делает версию ВХОДОМ следующего раунда анализа — между созданием
  // и активацией рецензия могла перезапуститься; активировать поверх
  // незавершённой рецензии нельзя (тот же гейт, что у создания).
  await assertReviewReady(tenderId, 'активацию согласованной версии');

  await db.transaction(async (tx) => {
    await tx.queryRun(
      `UPDATE tz_agreed_versions SET status = 'archived' WHERE tender_id = ? AND status = 'active'`,
      tenderId,
    );
    await tx.queryRun(
      `UPDATE tz_agreed_versions SET status = 'active' WHERE id = ?`, versionId,
    );
  });

  await audit.record({
    requestId,
    tenantId: actor && actor.tenantId,
    actorSub: actor && actor.subject,
    action: 'agreed_version.activate', category: 'decision', outcome: 'allowed',
    tenderId, resourceType: 'agreed_version', resourceId: versionId,
    meta: { version_no: Number(row.version_no) },
  }).catch(() => {});

  return getVersion(tenderId, versionId);
}

async function archiveVersion(tenderId, versionId, { actor = null, requestId = null } = {}) {
  const row = await db.queryOne(
    'SELECT * FROM tz_agreed_versions WHERE id = ? AND tender_id = ?', versionId, tenderId,
  );
  if (!row) throw notFound('Согласованная версия не найдена');
  await db.queryRun(`UPDATE tz_agreed_versions SET status = 'archived' WHERE id = ?`, versionId);
  await audit.record({
    requestId,
    tenantId: actor && actor.tenantId,
    actorSub: actor && actor.subject,
    action: 'agreed_version.archive', category: 'decision', outcome: 'allowed',
    tenderId, resourceType: 'agreed_version', resourceId: versionId,
    meta: { version_no: Number(row.version_no) },
  }).catch(() => {});
  return getVersion(tenderId, versionId);
}

module.exports = {
  // чистое ядро — см. agreedTextBuilder.js
  versionAsDocument,
  snapshotToExportRows,
  // DB
  loadExportDecisions,
  createAgreedVersion,
  getVersion,
  listVersions,
  activateVersion,
  archiveVersion,
  getActiveAgreedVersion,
  getActiveAgreedDocument,
  loadDecisionsForBuild,
};
