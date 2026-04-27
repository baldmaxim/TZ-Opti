'use strict';

const db = require('../db/connection');
const { getActiveTzText, getTzDocument, splitParagraphs } = require('./tzActiveTextService');

function escapeHtml(s) {
  return (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderReviewHtml(tenderId) {
  const tender = db.prepare('SELECT * FROM tenders WHERE id = ?').get(tenderId);
  if (!tender) return '<h1>Тендер не найден</h1>';
  const tzDoc = getTzDocument(tenderId);
  if (!tzDoc) {
    return wrap(`<h1>${escapeHtml(tender.title)}</h1><p>В тендер не загружен документ типа «ТЗ».</p>`);
  }

  const paragraphs = splitParagraphs(tzDoc.extracted_text || '');
  const issues = db
    .prepare(`
      SELECT i.*, d.decision as decision_kind, d.final_comment as decision_comment, d.edited_redaction as decision_redaction
      FROM issues i
      LEFT JOIN review_decisions d ON d.issue_id = i.id
      WHERE i.tender_id = ? AND i.review_status IN ('accepted', 'edited', 'pending')
      ORDER BY i.paragraph_index ASC, i.char_start ASC
    `)
    .all(tenderId);

  const byParagraph = new Map();
  for (const issue of issues) {
    if (issue.paragraph_index == null) continue;
    if (!byParagraph.has(issue.paragraph_index)) byParagraph.set(issue.paragraph_index, []);
    byParagraph.get(issue.paragraph_index).push(issue);
  }

  const blocks = paragraphs.map((p) => renderParagraph(p, byParagraph.get(p.index) || [])).join('\n');

  return wrap(`
    <h1>${escapeHtml(tender.title)}</h1>
    <p class="meta">Заказчик: ${escapeHtml(tender.customer || '—')} • Стадия: ${escapeHtml(tender.stage || '—')}</p>
    <hr/>
    <div class="doc">${blocks}</div>
  `, tender.title);
}

function renderParagraph(p, paraIssues) {
  if (!paraIssues.length) {
    return `<p class="para"><span class="num">${p.index + 1}.</span> ${escapeHtml(p.text)}</p>`;
  }
  paraIssues.sort((a, b) => (a.char_start || 0) - (b.char_start || 0));
  let html = '';
  let cursor = 0;
  const text = p.text;
  for (const issue of paraIssues) {
    const start = Math.max(0, Math.min(text.length, issue.char_start ?? 0));
    const end = Math.max(start, Math.min(text.length, issue.char_end ?? start));
    if (start > cursor) html += escapeHtml(text.slice(cursor, start));
    const fragment = text.slice(start, end);
    const cls = issueCss(issue);
    html += `<mark class="${cls}" data-issue="${issue.id}">${escapeHtml(fragment)}<sup class="badge">${issue.analysis_stage}</sup></mark>`;
    cursor = end;
  }
  if (cursor < text.length) html += escapeHtml(text.slice(cursor));
  const notes = paraIssues
    .map((i) => renderNote(i))
    .join('');
  return `<div class="para-block">
    <p class="para"><span class="num">${p.index + 1}.</span> ${html}</p>
    <div class="notes">${notes}</div>
  </div>`;
}

function renderNote(issue) {
  const status = issue.review_status === 'accepted'
    ? 'принято'
    : issue.review_status === 'rejected'
      ? 'отклонено'
      : issue.review_status === 'edited'
        ? 'отредактировано'
        : 'на рассмотрении';
  const cls = `note note-${issue.review_status}`;
  const lines = [];
  lines.push(`<strong>Стадия ${issue.analysis_stage}: ${escapeHtml(humanize(issue.problem_type))}</strong>`);
  if (issue.criticality) lines.push(`<em>Критичность: ${escapeHtml(humanCrit(issue.criticality))}</em>`);
  if (issue.review_comment || issue.decision_comment) lines.push(escapeHtml(issue.decision_comment || issue.review_comment));
  const redaction = issue.decision_redaction || issue.edited_redaction || issue.suggested_redaction;
  if (redaction) lines.push(`<span class="redaction">→ ${escapeHtml(redaction)}</span>`);
  if (issue.basis) lines.push(`<span class="basis">${escapeHtml(issue.basis)}</span>`);
  lines.push(`<span class="status">Статус: ${status}</span>`);
  return `<div class="${cls}">${lines.join('<br/>')}</div>`;
}

function issueCss(issue) {
  const sev = issue.criticality === 'critical' ? 'crit' : issue.criticality;
  const status = issue.review_status;
  return `mark-${sev} mark-${status}`;
}

function humanize(s) { return (s || '').replace(/_/g, ' '); }
function humanCrit(s) {
  if (s === 'critical') return 'критическая';
  if (s === 'high') return 'высокая';
  if (s === 'medium') return 'средняя';
  if (s === 'low') return 'низкая';
  return s || '';
}

function wrap(body, title) {
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"/>
<title>Рецензия — ${escapeHtml(title || 'ТЗ')}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 1100px; margin: 24px auto; padding: 0 16px; color: #1f2937; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  .meta { color: #6b7280; font-size: 13px; margin: 0 0 16px; }
  hr { border: 0; border-top: 1px solid #e5e7eb; margin: 16px 0; }
  .para { line-height: 1.6; margin: 8px 0; }
  .num { color: #9ca3af; margin-right: 8px; font-variant-numeric: tabular-nums; }
  .para-block { background: #f9fafb; padding: 8px 12px; border-radius: 8px; margin: 8px 0; }
  mark { padding: 1px 3px; border-radius: 3px; }
  .mark-high { background: #fee2e2; }
  .mark-critical { background: #fecaca; }
  .mark-medium { background: #fef3c7; }
  .mark-low { background: #e0f2fe; }
  .mark-accepted { box-shadow: inset 0 -2px 0 0 #16a34a; }
  .mark-rejected { text-decoration: line-through; opacity: 0.6; }
  .mark-edited { box-shadow: inset 0 -2px 0 0 #2563eb; }
  .badge { font-size: 9px; color: #6b7280; margin-left: 2px; }
  .notes { margin-top: 6px; display: flex; flex-direction: column; gap: 6px; }
  .note { padding: 8px 10px; border-left: 3px solid #d1d5db; background: white; font-size: 13px; }
  .note-accepted { border-left-color: #16a34a; }
  .note-rejected { border-left-color: #9ca3af; }
  .note-edited { border-left-color: #2563eb; }
  .note-pending { border-left-color: #f59e0b; }
  .redaction { color: #1d4ed8; }
  .basis { color: #6b7280; font-size: 12px; }
  .status { color: #6b7280; font-size: 12px; }
</style></head>
<body>${body}</body></html>`;
}

module.exports = { renderReviewHtml };
