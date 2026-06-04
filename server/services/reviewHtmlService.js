'use strict';

const db = require('../db/connection');
const { getActiveTzText } = require('./tzActiveTextService');
const { decisionVisual, resolveRedaction } = require('./review/decisionModel');

function escapeHtml(s) {
  return (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function renderReviewHtml(tenderId) {
  const tender = await db.queryOne('SELECT * FROM tenders WHERE id = ?', tenderId);
  if (!tender) return '<h1>Тендер не найден</h1>';
  const tz = await getActiveTzText(tenderId, 99);
  if (!tz.document) {
    return wrap(
      `<h1>${escapeHtml(tender.title)}</h1>`
        + '<p>В слот ТЗ не загружена .md-копия. HTML-рецензия строится только по .md-варианту.</p>',
      tender.title,
    );
  }

  const paragraphs = tz.blocks;
  const issues = await db.queryAll(
    `
      SELECT i.*, d.decision as decision_kind, d.final_comment as decision_comment, d.edited_redaction as decision_redaction, d.target_text as decision_target_text
      FROM issues i
      LEFT JOIN review_decisions d ON d.issue_id = i.id
      WHERE i.tender_id = ? AND i.review_status IN ('accepted', 'edited', 'pending')
      ORDER BY i.paragraph_index ASC, i.char_start ASC
    `,
    tenderId,
  );

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
    let start = Math.max(0, Math.min(text.length, issue.char_start ?? 0));
    let end = Math.max(start, Math.min(text.length, issue.char_end ?? start));
    // Подчасть фрагмента (delete/edit на выделенную часть) — подсвечиваем только её,
    // как в docx/md. target_text есть только у таких решений.
    const part = (issue.decision_target_text || '').trim();
    if (part) {
      const i = text.slice(start, end).indexOf(part);
      if (i !== -1) { start += i; end = start + part.length; }
    }
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

// Единый «вид решения» — тот же, что в docx-экспорте и md (decisionModel).
// Без решения (pending) — нейтральная подсветка «на рассмотрении».
function issueVisual(issue) {
  if (!issue.decision_kind && issue.review_status === 'pending') {
    return { mark: 'pending', label: 'на рассмотрении', tag: null };
  }
  const kind = issue.decision_kind || (issue.review_status === 'edited' ? 'edit' : 'accept');
  const v = decisionVisual(kind);
  return { mark: v.mark, label: v.label, tag: v.tag || null };
}

function renderNote(issue) {
  const v = issueVisual(issue);
  const cls = `note notev-${v.mark}`;
  const lines = [];
  lines.push(`<strong>Стадия ${issue.analysis_stage}: ${escapeHtml(humanize(issue.problem_type))}</strong>`);
  if (issue.criticality) lines.push(`<em>Критичность: ${escapeHtml(humanCrit(issue.criticality))}</em>`);
  const comment = issue.decision_comment || issue.review_comment;
  if (comment) lines.push(escapeHtml(comment));
  const redaction = resolveRedaction(issue, {});
  if (redaction) lines.push(`<span class="redaction">→ ${escapeHtml(redaction)}</span>`);
  if (v.tag) lines.push(`<span class="tag">${escapeHtml(v.tag)}</span>`);
  if (issue.basis) lines.push(`<span class="basis">${escapeHtml(issue.basis)}</span>`);
  lines.push(`<span class="status">Решение: ${escapeHtml(v.label)}</span>`);
  return `<div class="${cls}">${lines.join('<br/>')}</div>`;
}

function issueCss(issue) {
  const sev = issue.criticality || 'low';
  return `mark-${sev} markv-${issueVisual(issue).mark}`;
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
  /* Вид решения (единый с docx/md): strike=удалить/вынести, replace=изменить,
     note=примечание, rejected=отклонено, pending=на рассмотрении. */
  .markv-strike { text-decoration: line-through; }
  .markv-replace { box-shadow: inset 0 -2px 0 0 #2563eb; }
  .markv-note { box-shadow: inset 0 -2px 0 0 #16a34a; }
  .markv-rejected { text-decoration: line-through; opacity: 0.6; }
  .markv-pending { box-shadow: inset 0 -2px 0 0 #f59e0b; }
  .badge { font-size: 9px; color: #6b7280; margin-left: 2px; }
  .notes { margin-top: 6px; display: flex; flex-direction: column; gap: 6px; }
  .note { padding: 8px 10px; border-left: 3px solid #d1d5db; background: white; font-size: 13px; }
  .notev-strike { border-left-color: #dc2626; }
  .notev-replace { border-left-color: #2563eb; }
  .notev-note { border-left-color: #16a34a; }
  .notev-rejected { border-left-color: #9ca3af; }
  .notev-pending { border-left-color: #f59e0b; }
  .redaction { color: #1d4ed8; }
  .tag { display: inline-block; font-size: 11px; color: #7c3aed; background: #f3e8ff; border-radius: 4px; padding: 0 6px; }
  .basis { color: #6b7280; font-size: 12px; }
  .status { color: #6b7280; font-size: 12px; }
</style></head>
<body>${body}</body></html>`;
}

module.exports = { renderReviewHtml };
