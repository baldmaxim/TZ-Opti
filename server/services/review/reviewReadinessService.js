'use strict';

// ГОТОВНОСТЬ РЕЦЕНЗИИ — жёсткий гейт перед выгрузками и согласованной версией.
//
// Прежде экспорт незавершённой рецензии не запрещался: docx/CSV/JSON/MD можно
// было выгрузить при нерешённых кластерах, а пустой массив кластерных решений
// МОЛЧА включал legacy issue-путь. Теперь:
//   • единый отчёт готовности (getReadiness) считает решённость рабочего списка
//     кластеров, хвост переноса решений и свежесть снимка;
//   • assertReviewReady БЛОКИРУЕТ (409 REVIEW_NOT_READY) docx-экспорт,
//     CSV/JSON/summary/review.md, создание и активацию согласованной версии;
//   • legacy issue-путь включается ТОЛЬКО явным запросом (?source=issues /
//     пер-стадийный ?stage=) — не «в массиве решений пусто».
//
// Что означает «готово» (export_allowed):
//   • есть активный pipeline-снимок (итог собран);
//   • снимок не устарел (ревизия документов не менялась после сборки);
//   • у КАЖДОГО кластера рабочего списка (verdict='publish' — то, что видит
//     инженер) есть решение — accept/edit/… ИЛИ reject: отклонить всё — тоже
//     завершённая рецензия;
//   • нет неразобранного переноса решений с прошлого прогона (carry-over).

const db = require('../../db/connection');
const analysisRuns = require('../analysisRuns/analysisRunsService');

// --- Чистое ядро (офлайн-тесты) ------------------------------------------------

// clusters: [{ id, show_to_engineer }], decisions: Map<cluster_id, {decision}>.
function computeReadiness({
  pipelineRunId = null,
  documentRevisionId = null,
  currentRevisionId = null,
  clusters = [],
  decisions = new Map(),
  carryoversPending = 0,
} = {}) {
  const working = clusters.filter((c) => c.show_to_engineer === 1 || c.show_to_engineer === true);
  let decided = 0;
  let rejected = 0;
  for (const c of working) {
    const d = decisions.get(c.id);
    if (!d) continue;
    decided += 1;
    if (String(d.decision || '').toLowerCase() === 'reject') rejected += 1;
  }
  const unresolved = working.length - decided;
  const stale = Boolean(
    pipelineRunId && documentRevisionId && currentRevisionId && documentRevisionId !== currentRevisionId,
  );

  const reasons = [];
  if (!pipelineRunId) reasons.push('итог анализа не собран (нет активного снимка конвейера)');
  if (stale) reasons.push('снимок собран по прежней ревизии документов — пересоберите анализ');
  if (unresolved > 0) reasons.push(`рецензия не завершена: без решения ${unresolved} из ${working.length} замечаний`);
  if (carryoversPending > 0) reasons.push(`не разобран перенос решений прошлого прогона: ${carryoversPending}`);

  return {
    pipeline_run_id: pipelineRunId,
    document_revision_id: documentRevisionId,
    total_clusters: working.length,
    decided_clusters: decided,
    rejected_clusters: rejected,
    accepted_clusters: decided - rejected,
    unresolved_clusters: unresolved,
    carryovers_pending: carryoversPending,
    pipeline_stale: stale,
    export_allowed: Boolean(pipelineRunId) && !stale && unresolved === 0 && carryoversPending === 0,
    reasons: reasons.length ? reasons : null,
  };
}

// --- DB-обвязка -----------------------------------------------------------------

async function getReadiness(tenderId) {
  const pipelineRunId = await analysisRuns.getActivePipelineRunId(tenderId);
  if (!pipelineRunId) return computeReadiness({ pipelineRunId: null });

  const run = await analysisRuns.getRun(pipelineRunId);
  const currentRevisionId = await analysisRuns.currentDocumentsRevision(tenderId);

  const clusters = await db.queryAll(
    'SELECT id, show_to_engineer FROM issue_clusters WHERE tender_id = ? AND analysis_run_id = ?',
    tenderId, pipelineRunId,
  );
  // Решения фильтруются и по прогону: cluster_id run-scoped, но фильтр защищает
  // от коллизий id между прогонами (NULL — легаси-решения без прогона).
  const decisionRows = clusters.length
    ? await db.queryAll(
      `SELECT cluster_id, decision FROM review_decisions
        WHERE cluster_id IN (${clusters.map(() => '?').join(', ')})
          AND (analysis_run_id = ? OR analysis_run_id IS NULL)`,
      ...clusters.map((c) => c.id), pipelineRunId,
    )
    : [];
  const decisions = new Map(decisionRows.map((r) => [r.cluster_id, r]));

  const carry = await analysisRuns.listCarryOverProposals(tenderId);
  const carryoversPending = (carry && Array.isArray(carry.proposals)) ? carry.proposals.length : 0;

  return computeReadiness({
    pipelineRunId,
    documentRevisionId: (run && run.documents_revision_id) || null,
    currentRevisionId,
    clusters,
    decisions,
    carryoversPending,
  });
}

// Гейт: рецензия не готова → 409 REVIEW_NOT_READY с полным отчётом (клиент
// показывает, чего именно не хватает). action — что блокируется (для текста).
async function assertReviewReady(tenderId, action = 'экспорт') {
  const readiness = await getReadiness(tenderId);
  if (!readiness.export_allowed) {
    const err = new Error(
      `Нельзя выполнить ${action}: ${(readiness.reasons || ['рецензия не завершена']).join('; ')}.`,
    );
    err.status = 409;
    err.code = 'REVIEW_NOT_READY';
    // details — контракт доменных ошибок (errorHandler кладёт их в тело 409):
    // клиент видит полный отчёт готовности, а не только текст.
    err.details = readiness;
    throw err;
  }
  return readiness;
}

module.exports = { computeReadiness, getReadiness, assertReviewReady };
