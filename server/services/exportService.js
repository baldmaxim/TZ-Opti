'use strict';

// Табличные/текстовые выгрузки (CSV / JSON / summary.md).
//
// Основной путь (этап 7) — cluster-level: строки берутся из issue_clusters +
// review_decisions(cluster_id) + primary draft_issue (через
// clusterReviewService.loadClusterReviewRows) — тот же source of truth, что у
// docx-экспорта. Legacy issue-level выгрузки (issues + review_decisions.issue_id)
// сохранены как fallback: когда кластеров нет (конвейер не собран) или запрошен
// явный ?source=issues. Диспетчеры exportCsv/exportJson/exportSummary возвращают
// { content, source }, чтобы контроллер показал источник в заголовке ответа.

const db = require('../db/connection');
const clusterReview = require('./review/clusterReviewService');

// --- Чистое ядро cluster-level (офлайн-тесты) --------------------------------

const CLUSTER_CSV_HEADERS = [
  'cluster_id', 'tz_clause', 'cluster_title', 'problem_type', 'criticality',
  'item_count', 'source_fragment', 'basis', 'recommendation',
  'suggested_action', 'suggested_redaction', 'edited_redaction',
  'decision', 'final_comment', 'review_status', 'decided_at',
];

// Статус рецензии кластера: нет решения — pending; reject — rejected; иначе decided.
function clusterReviewStatus(decision) {
  if (!decision) return 'pending';
  return decision.decision === 'reject' ? 'rejected' : 'decided';
}

// Строка CSV-реестра из {cluster, primary, decision} (порядок = CLUSTER_CSV_HEADERS).
function clusterCsvRow({ cluster, primary, decision }) {
  const p = primary || {};
  const d = decision || {};
  return {
    cluster_id: cluster.id,
    tz_clause: cluster.tz_clause || p.tz_clause || '',
    cluster_title: cluster.cluster_title || '',
    problem_type: cluster.final_problem_type || p.problem_type || '',
    criticality: cluster.overall_criticality || '',
    item_count: cluster.item_count ?? '',
    source_fragment: p.source_fragment || '',
    basis: cluster.merged_basis || p.basis || '',
    recommendation: cluster.merged_recommendation || '',
    suggested_action: p.suggested_action || '',
    suggested_redaction: p.suggested_redaction || '',
    edited_redaction: d.edited_redaction || '',
    decision: d.decision || '',
    final_comment: d.final_comment || '',
    review_status: clusterReviewStatus(decision),
    decided_at: d.decided_at || '',
  };
}

function clustersToCsv(rows) {
  const lines = [CLUSTER_CSV_HEADERS.join(';')];
  for (const r of rows) {
    const flat = clusterCsvRow(r);
    lines.push(CLUSTER_CSV_HEADERS.map((h) => csvCell(flat[h])).join(';'));
  }
  // UTF-8 BOM для корректного открытия в Excel
  return '﻿' + lines.join('\r\n');
}

// Свёртка по кластерам для summary.md: счётчики решений и критичности.
function clusterSummaryStats(rows) {
  const stats = {
    clusters: rows.length,
    draft_issues: rows.reduce((acc, { cluster }) => acc + (Number(cluster.item_count) || 0), 0),
    decided: 0,
    rejected: 0,
    pending: 0,
    by_decision: {},
    by_criticality: {},
    important: 0, // critical|high
  };
  for (const { cluster, decision } of rows) {
    const status = clusterReviewStatus(decision);
    stats[status === 'decided' ? 'decided' : status === 'rejected' ? 'rejected' : 'pending'] += 1;
    if (decision) {
      stats.by_decision[decision.decision] = (stats.by_decision[decision.decision] || 0) + 1;
    }
    const crit = cluster.overall_criticality || 'unknown';
    stats.by_criticality[crit] = (stats.by_criticality[crit] || 0) + 1;
    if (crit === 'critical' || crit === 'high') stats.important += 1;
  }
  return stats;
}

// --- Cluster-level выгрузки ---------------------------------------------------

async function exportClustersJson(tenderId, rows) {
  const tender = await db.queryOne('SELECT * FROM tenders WHERE id = ?', tenderId);
  const runs = await db.queryAll(
    'SELECT * FROM analysis_runs WHERE tender_id = ? ORDER BY stage ASC, started_at ASC',
    tenderId,
  );
  const clusters = rows.map(({ cluster, primary, decision }) => ({
    ...cluster,
    primary_draft_issue_id: primary ? primary.id : null,
    source_fragment: primary ? primary.source_fragment : null,
    suggested_redaction: primary ? primary.suggested_redaction : null,
    decision: decision || null,
    review_status: clusterReviewStatus(decision),
  }));
  return JSON.stringify(
    { tender, runs: runs.map(parseSummary), source: 'clusters', clusters },
    null,
    2,
  );
}

async function exportClustersSummaryMd(tenderId, rows) {
  const tender = await db.queryOne('SELECT * FROM tenders WHERE id = ?', tenderId);
  if (!tender) return '# Тендер не найден';
  const checklist = await db.queryAll('SELECT * FROM work_checklist_items WHERE tender_id = ?', tenderId);
  const stats = clusterSummaryStats(rows);
  const unaccountedWorks = checklist.filter((c) => !c.in_calc);

  const lines = [];
  lines.push(`# Сводка по тендеру: ${tender.title}`);
  lines.push('');
  lines.push(`**Заказчик:** ${tender.customer || '—'}`);
  lines.push(`**Тип:** ${tender.type || '—'}`);
  lines.push(`**Стадия:** ${tender.stage || '—'}`);
  lines.push(`**Срок подачи:** ${tender.deadline || '—'}`);
  lines.push('');
  lines.push('## Итоги анализа (кластеры замечаний)');
  lines.push(`- Кластеров замечаний: **${stats.clusters}** (сведено из ${stats.draft_issues} находок)`);
  lines.push(`- С решением инженера: **${stats.decided}**`);
  lines.push(`- Отклонено: **${stats.rejected}**`);
  lines.push(`- Без решения: **${stats.pending}**`);
  lines.push(`- Высокая/критическая значимость: **${stats.important}**`);
  lines.push('');
  lines.push('## По критичности');
  for (const crit of ['critical', 'high', 'medium', 'low']) {
    if (stats.by_criticality[crit]) lines.push(`- ${crit}: ${stats.by_criticality[crit]}`);
  }
  lines.push('');

  if (unaccountedWorks.length) {
    lines.push('## Работы, не учтённые в расчёте');
    for (const w of unaccountedWorks) {
      lines.push(`- ${w.work_name}${w.section ? ` (${w.section})` : ''}`);
    }
    lines.push('');
  }

  lines.push('## Ключевые замечания');
  const important = rows.filter(
    ({ cluster }) => cluster.overall_criticality === 'critical' || cluster.overall_criticality === 'high',
  );
  for (const { cluster, primary } of important.slice(0, 20)) {
    const basis = (cluster.merged_basis || (primary && primary.basis) || '').replace(/\s+/g, ' ').slice(0, 220);
    lines.push(`- **${cluster.cluster_title || cluster.final_problem_type || 'замечание'}** (${cluster.overall_criticality}): ${basis}`);
  }
  return lines.join('\n');
}

// --- Legacy issue-level выгрузки (fallback) ------------------------------------

const ISSUE_CSV_HEADERS = [
  'id', 'analysis_stage', 'problem_type', 'risk_category', 'criticality',
  'price_impact', 'schedule_impact', 'source_clause', 'source_fragment',
  'basis', 'suggested_action', 'suggested_redaction', 'edited_redaction',
  'review_comment', 'review_status', 'decision', 'final_comment', 'confidence',
];

async function exportIssuesCsv(tenderId) {
  const rows = await db.queryAll(
    `
      SELECT i.*, d.decision as decision, d.final_comment as final_comment
      FROM issues i
      LEFT JOIN review_decisions d ON d.issue_id = i.id
      WHERE i.tender_id = ?
      ORDER BY i.analysis_stage ASC, i.criticality DESC, i.paragraph_index ASC
    `,
    tenderId,
  );
  const lines = [ISSUE_CSV_HEADERS.join(';')];
  for (const r of rows) {
    lines.push(ISSUE_CSV_HEADERS.map((h) => csvCell(r[h])).join(';'));
  }
  return '﻿' + lines.join('\r\n');
}

async function exportIssuesJson(tenderId) {
  const tender = await db.queryOne('SELECT * FROM tenders WHERE id = ?', tenderId);
  const runs = await db.queryAll(
    'SELECT * FROM analysis_runs WHERE tender_id = ? ORDER BY stage ASC, started_at ASC',
    tenderId,
  );
  const issues = await db.queryAll(
    `
      SELECT i.*, d.decision as decision, d.final_comment as final_comment, d.edited_redaction as decision_redaction
      FROM issues i
      LEFT JOIN review_decisions d ON d.issue_id = i.id
      WHERE i.tender_id = ?
      ORDER BY i.analysis_stage ASC, i.criticality DESC
    `,
    tenderId,
  );
  return JSON.stringify({ tender, runs: runs.map(parseSummary), source: 'issues', issues }, null, 2);
}

async function exportIssuesSummaryMd(tenderId) {
  const tender = await db.queryOne('SELECT * FROM tenders WHERE id = ?', tenderId);
  if (!tender) return '# Тендер не найден';
  const issues = await db.queryAll(
    `
      SELECT i.*, d.decision as decision FROM issues i
      LEFT JOIN review_decisions d ON d.issue_id = i.id
      WHERE i.tender_id = ?
    `,
    tenderId,
  );
  const checklist = await db.queryAll('SELECT * FROM work_checklist_items WHERE tender_id = ?', tenderId);

  const accepted = issues.filter((i) => i.review_status === 'accepted' || i.review_status === 'edited');
  const rejected = issues.filter((i) => i.review_status === 'rejected');
  const pending = issues.filter((i) => i.review_status === 'pending');

  const byStage = (n) => issues.filter((i) => i.analysis_stage === n);
  const critIssues = issues.filter((i) => i.criticality === 'high' || i.criticality === 'critical');
  const unaccountedWorks = checklist.filter((c) => !c.in_calc);

  const lines = [];
  lines.push(`# Сводка по тендеру: ${tender.title}`);
  lines.push('');
  lines.push(`**Заказчик:** ${tender.customer || '—'}`);
  lines.push(`**Тип:** ${tender.type || '—'}`);
  lines.push(`**Стадия:** ${tender.stage || '—'}`);
  lines.push(`**Срок подачи:** ${tender.deadline || '—'}`);
  lines.push('');
  lines.push('## Итоги анализа');
  lines.push(`- Всего замечаний: **${issues.length}**`);
  lines.push(`- Принято/отредактировано: **${accepted.length}**`);
  lines.push(`- Отклонено: **${rejected.length}**`);
  lines.push(`- В работе: **${pending.length}**`);
  lines.push(`- Высокая/критическая критичность: **${critIssues.length}**`);
  lines.push('');
  lines.push('## По стадиям');
  for (let s = 1; s <= 5; s++) {
    lines.push(`- Стадия ${s}: ${byStage(s).length} замечаний`);
  }
  lines.push('');

  if (unaccountedWorks.length) {
    lines.push('## Работы, не учтённые в расчёте');
    for (const w of unaccountedWorks) {
      lines.push(`- ${w.work_name}${w.section ? ` (${w.section})` : ''}`);
    }
    lines.push('');
  }

  lines.push('## Ключевые риски');
  for (const i of critIssues.slice(0, 20)) {
    const stageLabel = `[Стадия ${i.analysis_stage}]`;
    lines.push(`- ${stageLabel} **${i.problem_type || 'риск'}** (${i.criticality}): ${i.basis || ''}`);
  }
  return lines.join('\n');
}

// --- Диспетчеры: cluster-primary, issue-fallback --------------------------------

// source='issues' принудительно включает legacy; иначе issue-путь используется,
// только когда кластеров нет (конвейер не собран).
async function loadClusterRowsUnlessLegacy(tenderId, source) {
  if (source === 'issues') return [];
  return clusterReview.loadClusterReviewRows(tenderId, 'full');
}

async function exportCsv(tenderId, { source = null } = {}) {
  const rows = await loadClusterRowsUnlessLegacy(tenderId, source);
  if (rows.length) return { content: clustersToCsv(rows), source: 'clusters' };
  return { content: await exportIssuesCsv(tenderId), source: 'issues' };
}

async function exportJson(tenderId, { source = null } = {}) {
  const rows = await loadClusterRowsUnlessLegacy(tenderId, source);
  if (rows.length) return { content: await exportClustersJson(tenderId, rows), source: 'clusters' };
  return { content: await exportIssuesJson(tenderId), source: 'issues' };
}

async function exportSummary(tenderId, { source = null } = {}) {
  const rows = await loadClusterRowsUnlessLegacy(tenderId, source);
  if (rows.length) return { content: await exportClustersSummaryMd(tenderId, rows), source: 'clusters' };
  return { content: await exportIssuesSummaryMd(tenderId), source: 'issues' };
}

// --- Общие хелперы ---------------------------------------------------------------

function csvCell(v) {
  if (v == null) return '';
  let s = String(v).replace(/\r?\n/g, ' ').trim();
  if (s.includes(';') || s.includes('"')) {
    s = '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function parseSummary(run) {
  let summary = null;
  try { summary = run.summary ? JSON.parse(run.summary) : null; } catch (_e) { summary = null; }
  return { ...run, summary };
}

module.exports = {
  // диспетчеры (cluster-primary, issue-fallback)
  exportCsv,
  exportJson,
  exportSummary,
  // чистое ядро cluster-level (офлайн-тесты)
  CLUSTER_CSV_HEADERS,
  clusterReviewStatus,
  clusterCsvRow,
  clustersToCsv,
  clusterSummaryStats,
};
