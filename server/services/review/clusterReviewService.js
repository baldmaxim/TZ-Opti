'use strict';

// Слой cluster-review (этапы 6–7) — делает issue_clusters основным объектом рецензии
// и всех выгрузок. Source of truth:
//   signals → draft_issues → issue_reviews → issue_clusters → review_decisions(cluster_id) → export.
//
// Отсюда читают ВСЕ cluster-level поверхности: docx-экспорт (exportController),
// CSV/JSON/summary.md (exportService), HTML-preview (reviewHtmlService) и review.md
// (mdReview/renderer). Issue-level путь (issues → review_decisions.issue_id) сохранён
// только как legacy-fallback, когда кластеров нет или запрошен ?source=issues.
//
// Ключевая идея экспорта без переписывания reviewDocx: docx локализует место по ТЕКСТУ
// (source_fragment, см. reviewDocx/index.js locateTarget), поэтому кластеру достаточно
// дать «issue-подобный» объект из его primary draft_issue — clusterToExportIssue().

const db = require('../../db/connection');
const { newId, nowIso } = require('../../utils/ids');
const { badRequest, notFound } = require('../../utils/errors');
const clustering = require('../clustering/clusteringService');
const analysisRuns = require('../analysisRuns/analysisRunsService');
const { runPipeline } = require('../pipeline/analysisPipeline');
const { humanizeNoteText } = require('./noteText');

const ALLOWED_DECISIONS = ['accept', 'reject', 'edit', 'delete', 'remove_from_scope'];

// hn — короткий алиас humanizeNoteText для текстовых полей инженера.
const hn = humanizeNoteText;

// Чистые обёртки: возвращают КОПИЮ объекта с гуманизированными текстовыми
// полями (source_fragment не трогаем — дословная цитата ТЗ). null-безопасны.
function scrubCluster(c) {
  if (!c) return c;
  return {
    ...c,
    merged_basis: hn(c.merged_basis),
    merged_recommendation: hn(c.merged_recommendation),
  };
}
function scrubDraft(d) {
  if (!d) return d;
  return {
    ...d,
    basis: hn(d.basis),
    suggested_redaction: hn(d.suggested_redaction),
  };
}

// --- Чистое ядро (тестируется без БД) --------------------------------------

// Синтетический «issue» для экспорта из кластера + его primary draft_issue.
// Поля — ровно те, что читают reviewDocx/index.js applyOne и review/decisionModel.js:
//   id, analysis_stage, source_fragment, source_clause, paragraph_index,
//   problem_type, suggested_action, suggested_redaction, review_comment.
function clusterToExportIssue(cluster, primaryDraft = {}) {
  return {
    id: cluster.id,
    analysis_stage: null, // кластер сводит несколько стадий — единой стадии нет
    cluster_id: cluster.id,
    source_fragment: primaryDraft.source_fragment || null,
    source_clause: cluster.tz_clause || primaryDraft.tz_clause || null,
    paragraph_index:
      cluster.paragraph_index != null ? cluster.paragraph_index : (primaryDraft.paragraph_index ?? null),
    problem_type: cluster.final_problem_type || primaryDraft.problem_type || null,
    suggested_action: primaryDraft.suggested_action || null,
    suggested_redaction: hn(primaryDraft.suggested_redaction) || null,
    // review_comment — подсказка для UI; в Word уходит только final_comment из решения.
    review_comment: hn(cluster.merged_recommendation) || null,
    criticality: cluster.overall_criticality || null,
  };
}

// reject не экспортируется (как и на issue-пути). Возвращает kind для applyOne.
function decisionKindFor(decision) {
  return (decision || '').toString();
}

// --- DB-обвязка -------------------------------------------------------------

// Достроить конвейер до кластеров. force=true — пересобрать целиком (подхватить
// новые сигналы стадий).
//
// Сборку ведёт ОРКЕСТРАТОР (pipeline/analysisPipeline): кандидат → слои → проверка
// входов → активация. Свой жизненный цикл здесь больше не дублируется — иначе
// пришлось бы дублировать и проверки набора stage-прогонов, и правило «активируем
// только по полному успеху». Сбой сборки НЕ снимает прежний снимок: указатель
// остаётся на нём, метод сообщает причину.
async function ensureReviewPipeline(tenderId, { force = false } = {}) {
  const activeRunId = await analysisRuns.getActivePipelineRunId(tenderId);
  if (!force && activeRunId) {
    const row = await db.queryOne(
      'SELECT COUNT(*) AS c FROM issue_clusters WHERE tender_id = ? AND analysis_run_id = ?',
      tenderId, activeRunId,
    );
    if (Number(row && row.c) > 0) return { built: false, clusters: Number(row.c) };
  }
  const report = await runPipeline(tenderId, { withSelfAnalysis: false });
  if (!report.ok) {
    return {
      built: false,
      clusters: 0,
      error: report.error || (report.failed_step ? `шаг «${report.failed_step}» не выполнен` : 'сборка не удалась'),
      report,
    };
  }
  const step = (report.steps || []).find((s) => s.step === 'clustering');
  const summary = (step && step.summary) || {};
  return { built: true, clusters: summary.clusters || 0, run_id: report.run_id, summary };
}

async function getCluster(tenderId, clusterId) {
  // Только кластер АКТУАЛЬНОГО прогона — по архивным кластерам не решаем/не смотрим.
  const rid = await analysisRuns.getActivePipelineRunId(tenderId);
  if (!rid) return undefined;
  return db.queryOne(
    'SELECT * FROM issue_clusters WHERE id = ? AND tender_id = ? AND analysis_run_id = ?',
    clusterId, tenderId, rid,
  );
}

// Решения по списку кластеров одним запросом → Map<cluster_id, decision-row>.
async function loadDecisionsByCluster(clusterIds) {
  if (!clusterIds.length) return new Map();
  const ph = clusterIds.map(() => '?').join(', ');
  const rows = await db.queryAll(
    `SELECT * FROM review_decisions WHERE cluster_id IN (${ph}) ORDER BY decided_at ASC`,
    ...clusterIds,
  );
  const map = new Map();
  for (const r of rows) map.set(r.cluster_id, r); // последний по времени побеждает
  return map;
}

// Заметки self-analysis по списку кластеров → Map<cluster_id, notes[]>.
async function loadSelfAnalysisByCluster(tenderId, clusterIds) {
  const map = new Map();
  if (!clusterIds.length) return map;
  const ph = clusterIds.map(() => '?').join(', ');
  const rows = await db.queryAll(
    `SELECT id, cluster_id, finding_type, comment, suggested_improvement, confidence, source
       FROM self_analysis_results
      WHERE tender_id = ? AND cluster_id IN (${ph})
      ORDER BY created_at ASC`,
    tenderId,
    ...clusterIds,
  );
  for (const r of rows) {
    if (!map.has(r.cluster_id)) map.set(r.cluster_id, []);
    map.get(r.cluster_id).push(r);
  }
  return map;
}

// Primary draft_issue по списку кластеров → Map<cluster_id, draft_issue-row>.
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

// Список кластеров для review UI: кластеры (working|full) + сохранённое решение +
// дочерние draft_issues (основания/сигналы) + заметки self-analysis. Один bundle/кластер.
async function listReviewClusters(tenderId, mode = 'working') {
  const clusters = await clustering.listClusters(tenderId, mode);
  if (!clusters.length) return [];
  const ids = clusters.map((c) => c.id);
  const [decisions, selfNotes] = await Promise.all([
    loadDecisionsByCluster(ids),
    loadSelfAnalysisByCluster(tenderId, ids),
  ]);
  return clusters.map((c) => {
    const d = decisions.get(c.id) || null;
    return {
      ...c,
      decision: d
        ? {
            decision: d.decision,
            edited_redaction: d.edited_redaction,
            final_comment: d.final_comment,
            target_text: d.target_text,
            decided_at: d.decided_at,
          }
        : null,
      self_analysis: selfNotes.get(c.id) || [],
    };
  });
}

// Один кластер с полной объяснимостью (для детального экрана).
async function getReviewCluster(tenderId, clusterId) {
  const cluster = await getCluster(tenderId, clusterId);
  if (!cluster) throw notFound('Кластер не найден');
  const [list] = await Promise.all([listReviewClusters(tenderId, 'full')]);
  const found = list.find((c) => c.id === clusterId);
  return found || { ...cluster, items: [], decision: null, self_analysis: [] };
}

// Сохранить решение инженера по кластеру (idempotent: одно активное решение на кластер).
async function saveClusterDecision(tenderId, clusterId, body = {}) {
  const cluster = await getCluster(tenderId, clusterId);
  if (!cluster) throw notFound('Кластер не найден');
  const { decision, edited_redaction, final_comment, target_text } = body;
  if (!ALLOWED_DECISIONS.includes(decision)) {
    throw badRequest('Допустимые решения: ' + ALLOWED_DECISIONS.join(', '));
  }
  const targetText = (target_text || '').trim() || null;

  await db.transaction(async (tx) => {
    await tx.queryRun('DELETE FROM review_decisions WHERE cluster_id = ?', clusterId);
    await tx.queryRun(
      `INSERT INTO review_decisions
         (id, issue_id, cluster_id, analysis_run_id, cluster_key, decision, edited_redaction, final_comment, target_text, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId(),
      null,
      clusterId,
      cluster.analysis_run_id || null, // решение привязано к прогону кластера
      cluster.cluster_key || null,     // стабильная сигнатура — для явного переноса
      decision,
      edited_redaction || null,
      final_comment || null,
      targetText,
      nowIso(),
    );
  });

  const row = await db.queryOne(
    'SELECT * FROM review_decisions WHERE cluster_id = ? ORDER BY decided_at DESC LIMIT 1',
    clusterId,
  );
  return { cluster_id: clusterId, decision: row };
}

// Общий источник cluster-level выгрузок (CSV/JSON/summary.md, HTML-preview):
// ВСЕ кластеры тендера (включая нерешённые) + последнее решение + primary draft_issue.
async function loadClusterReviewRows(tenderId, mode = 'full') {
  const clusters = await clustering.listClusters(tenderId, mode);
  if (!clusters.length) return [];
  const ids = clusters.map((c) => c.id);
  const [decisions, primaries] = await Promise.all([
    loadDecisionsByCluster(ids),
    loadPrimaryDrafts(ids),
  ]);
  return clusters.map((c) => ({
    cluster: scrubCluster(c),
    primary: scrubDraft(primaries.get(c.id) || null),
    decision: decisions.get(c.id) || null,
  }));
}

// Источник для экспорта: кластеры с решением (кроме reject) → синтетический issue +
// данные решения. Формат строки совпадает с issue-путём (exportController.loadDecisions):
//   { issue, decision_kind, final_comment, edited_redaction, target_text }
async function loadClusterDecisions(tenderId) {
  const rid = await analysisRuns.getActivePipelineRunId(tenderId);
  if (!rid) return [];
  const rows = await db.queryAll(
    `SELECT c.*, rd.decision AS decision_kind, rd.edited_redaction AS dec_redaction,
            rd.final_comment AS final_comment, rd.target_text AS target_text
       FROM issue_clusters c
       JOIN review_decisions rd ON rd.cluster_id = c.id
      WHERE c.tender_id = ? AND c.analysis_run_id = ? AND rd.decision <> 'reject'
      ORDER BY c.paragraph_index ASC NULLS LAST, c.created_at ASC`,
    tenderId, rid,
  );
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const primaries = await loadPrimaryDrafts(ids);
  return rows.map((r) => {
    const primary = primaries.get(r.id) || {};
    return {
      issue: clusterToExportIssue(r, primary),
      decision_kind: decisionKindFor(r.decision_kind),
      final_comment: r.final_comment,
      edited_redaction: hn(r.dec_redaction || primary.suggested_redaction) || null,
      target_text: r.target_text || null,
    };
  });
}

module.exports = {
  // чистое ядро (офлайн-тесты)
  clusterToExportIssue,
  decisionKindFor,
  ALLOWED_DECISIONS,
  // DB
  ensureReviewPipeline,
  listReviewClusters,
  getReviewCluster,
  saveClusterDecision,
  loadClusterDecisions,
  loadClusterReviewRows,
};
