'use strict';

const db = require('../db/connection');

const CSV_HEADERS = [
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
  const lines = [CSV_HEADERS.join(';')];
  for (const r of rows) {
    lines.push(CSV_HEADERS.map((h) => csvCell(r[h])).join(';'));
  }
  // UTF-8 BOM для корректного открытия в Excel
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
  return JSON.stringify({ tender, runs: runs.map(parseSummary), issues }, null, 2);
}

async function exportSummaryMd(tenderId) {
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
  for (let s = 1; s <= 4; s++) {
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
  exportIssuesCsv,
  exportIssuesJson,
  exportSummaryMd,
};
