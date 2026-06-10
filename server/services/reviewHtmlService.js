'use strict';

// HTML-preview рецензии поверх .md-копии ТЗ.
//
// Основной путь (этап 7) — кластеры: issue_clusters + review_decisions(cluster_id);
// место в тексте локализуется по source_fragment primary draft_issue (поиск по тексту,
// как в docx-экспорте). Legacy issue-level путь (issues + review_decisions.issue_id)
// сохранён как fallback: когда кластеров нет или запрошен ?source=issues.
// Обе ветки сводятся к единому виду «аннотации» — рендер один.
// Вид решения единый с docx/md — decisionModel.

const db = require('../db/connection');
const { getActiveTzText } = require('./tzActiveTextService');
const { decisionVisual, resolveRedaction } = require('./review/decisionModel');
const clusterReview = require('./review/clusterReviewService');

function escapeHtml(s) {
  return (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// --- Чистое ядро (офлайн-тесты) ------------------------------------------------

// Локализация фрагмента в абзацах ТЗ: сперва в подсказанном paragraph_index,
// затем по всем абзацам. Возвращает { paragraph_index, char_start, char_end } | null.
function locateFragment(blocks, hintIndex, fragment) {
  const frag = (fragment || '').trim();
  if (!frag) return null;
  const tryBlock = (b) => {
    const i = (b.text || '').indexOf(frag);
    return i === -1 ? null : { paragraph_index: b.index, char_start: i, char_end: i + frag.length };
  };
  if (hintIndex != null) {
    const hinted = blocks.find((b) => b.index === hintIndex);
    if (hinted) {
      const hit = tryBlock(hinted);
      if (hit) return hit;
    }
  }
  for (const b of blocks) {
    const hit = tryBlock(b);
    if (hit) return hit;
  }
  return null;
}

// Вид решения кластера: нет решения — нейтральное «на рассмотрении».
function clusterVisual(decision) {
  if (!decision) return { mark: 'pending', label: 'на рассмотрении', tag: null };
  const v = decisionVisual(decision.decision);
  return { mark: v.mark, label: v.label, tag: v.tag || null };
}

// Кластер + primary draft + решение → аннотация для рендера. loc может быть null
// (фрагмент не найден в тексте) — такие аннотации попадают в список «вне текста».
function clusterToAnnotation(cluster, primary, decision, loc) {
  const p = primary || {};
  const d = decision || {};
  return {
    id: cluster.id,
    badge: Number(cluster.item_count) > 1 ? `К×${cluster.item_count}` : 'К',
    title: cluster.cluster_title || humanize(cluster.final_problem_type) || 'Замечание',
    criticality: cluster.overall_criticality || null,
    comment: d.final_comment || cluster.merged_recommendation || null,
    redaction: resolveRedaction({ suggested_redaction: p.suggested_redaction || null }, d),
    basis: cluster.merged_basis || p.basis || null,
    visual: clusterVisual(decision),
    paragraph_index: loc ? loc.paragraph_index : null,
    char_start: loc ? loc.char_start : null,
    char_end: loc ? loc.char_end : null,
    target_text: d.target_text || null,
  };
}

// Legacy: строка issues+decision → та же аннотация (бейдж = номер стадии).
function issueToAnnotation(issue) {
  const visual = issueVisual(issue);
  return {
    id: issue.id,
    badge: String(issue.analysis_stage),
    title: `Стадия ${issue.analysis_stage}: ${humanize(issue.problem_type)}`,
    criticality: issue.criticality || null,
    comment: issue.decision_comment || issue.review_comment || null,
    redaction: resolveRedaction(issue, {}),
    basis: issue.basis || null,
    visual,
    paragraph_index: issue.paragraph_index,
    char_start: issue.char_start,
    char_end: issue.char_end,
    target_text: issue.decision_target_text || null,
  };
}

function issueVisual(issue) {
  if (!issue.decision_kind && issue.review_status === 'pending') {
    return { mark: 'pending', label: 'на рассмотрении', tag: null };
  }
  const kind = issue.decision_kind || (issue.review_status === 'edited' ? 'edit' : 'accept');
  const v = decisionVisual(kind);
  return { mark: v.mark, label: v.label, tag: v.tag || null };
}

// --- Загрузка аннотаций ----------------------------------------------------------

// Основной путь: кластеры (working — как в review UI). reject скрыт (как на issue-пути).
// null — кластеров нет вообще (конвейер не собран) → вызывающий падает на legacy.
async function loadClusterAnnotations(tenderId, blocks) {
  const rows = await clusterReview.loadClusterReviewRows(tenderId, 'working');
  if (!rows.length) return null;
  const located = [];
  const unlocated = [];
  for (const { cluster, primary, decision } of rows) {
    if (decision && decision.decision === 'reject') continue;
    const hint = cluster.paragraph_index != null
      ? cluster.paragraph_index
      : (primary ? primary.paragraph_index : null);
    const loc = locateFragment(blocks, hint, primary && primary.source_fragment);
    const ann = clusterToAnnotation(cluster, primary, decision, loc);
    (loc ? located : unlocated).push(ann);
  }
  return { annotations: located, unlocated };
}

// Legacy-путь: issues + review_decisions(issue_id). Без paragraph_index — не рисуем
// (прежнее поведение).
async function loadIssueAnnotations(tenderId) {
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
  return {
    annotations: issues.filter((i) => i.paragraph_index != null).map(issueToAnnotation),
    unlocated: [],
  };
}

// --- Рендер ------------------------------------------------------------------------

async function renderReviewHtml(tenderId, { source = null } = {}) {
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
  let data = null;
  let sourceUsed = 'issues';
  if (source !== 'issues') {
    data = await loadClusterAnnotations(tenderId, paragraphs);
    if (data) sourceUsed = 'clusters';
  }
  if (!data) data = await loadIssueAnnotations(tenderId);

  const byParagraph = new Map();
  for (const ann of data.annotations) {
    if (!byParagraph.has(ann.paragraph_index)) byParagraph.set(ann.paragraph_index, []);
    byParagraph.get(ann.paragraph_index).push(ann);
  }

  const blocks = paragraphs.map((p) => renderParagraph(p, byParagraph.get(p.index) || [])).join('\n');
  const sourceLabel = sourceUsed === 'clusters'
    ? 'кластеры замечаний (основной путь)'
    : 'находки стадий (legacy)';

  let body = `
    <h1>${escapeHtml(tender.title)}</h1>
    <p class="meta">Заказчик: ${escapeHtml(tender.customer || '—')} • Стадия: ${escapeHtml(tender.stage || '—')} • Решения: ${escapeHtml(sourceLabel)}</p>
    <hr/>
    <div class="doc">${blocks}</div>
  `;
  if (data.unlocated.length) {
    body += `
    <hr/>
    <h2 class="unlocated-h">Замечания вне текста (${data.unlocated.length})</h2>
    <p class="meta">Фрагмент не найден в .md-копии ТЗ — решение не потеряно, показано списком.</p>
    <div class="notes">${data.unlocated.map(renderNote).join('')}</div>
    `;
  }
  return wrap(body, tender.title);
}

function renderParagraph(p, anns) {
  if (!anns.length) {
    return `<p class="para"><span class="num">${p.index + 1}.</span> ${escapeHtml(p.text)}</p>`;
  }
  anns.sort((a, b) => (a.char_start || 0) - (b.char_start || 0));
  let html = '';
  let cursor = 0;
  const text = p.text;
  for (const ann of anns) {
    let start = Math.max(0, Math.min(text.length, ann.char_start ?? 0));
    let end = Math.max(start, Math.min(text.length, ann.char_end ?? start));
    // Подчасть фрагмента (delete/edit на выделенную часть) — подсвечиваем только её,
    // как в docx/md. target_text есть только у таких решений.
    const part = (ann.target_text || '').trim();
    if (part) {
      const i = text.slice(start, end).indexOf(part);
      if (i !== -1) { start += i; end = start + part.length; }
    }
    if (start < cursor) continue; // перекрытие с предыдущей аннотацией — не дублируем текст
    if (start > cursor) html += escapeHtml(text.slice(cursor, start));
    const fragment = text.slice(start, end);
    const cls = `mark-${ann.criticality || 'low'} markv-${ann.visual.mark}`;
    html += `<mark class="${cls}" data-issue="${ann.id}">${escapeHtml(fragment)}<sup class="badge">${escapeHtml(ann.badge)}</sup></mark>`;
    cursor = end;
  }
  if (cursor < text.length) html += escapeHtml(text.slice(cursor));
  const notes = anns.map(renderNote).join('');
  return `<div class="para-block">
    <p class="para"><span class="num">${p.index + 1}.</span> ${html}</p>
    <div class="notes">${notes}</div>
  </div>`;
}

function renderNote(ann) {
  const cls = `note notev-${ann.visual.mark}`;
  const lines = [];
  lines.push(`<strong>${escapeHtml(ann.title)}</strong>`);
  if (ann.criticality) lines.push(`<em>Критичность: ${escapeHtml(humanCrit(ann.criticality))}</em>`);
  if (ann.comment) lines.push(escapeHtml(ann.comment));
  if (ann.redaction) lines.push(`<span class="redaction">→ ${escapeHtml(ann.redaction)}</span>`);
  if (ann.visual.tag) lines.push(`<span class="tag">${escapeHtml(ann.visual.tag)}</span>`);
  if (ann.basis) lines.push(`<span class="basis">${escapeHtml(ann.basis)}</span>`);
  lines.push(`<span class="status">Решение: ${escapeHtml(ann.visual.label)}</span>`);
  return `<div class="${cls}">${lines.join('<br/>')}</div>`;
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
  .unlocated-h { font-size: 16px; }
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

module.exports = {
  renderReviewHtml,
  // чистое ядро (офлайн-тесты)
  locateFragment,
  clusterToAnnotation,
  issueToAnnotation,
};
