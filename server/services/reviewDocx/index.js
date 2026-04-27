'use strict';

const { DocxPackage } = require('./docxPackage');
const { extractParagraphs, findFragmentInParagraph } = require('./quoteLocator');
const { splitParagraphRuns } = require('./runSplitter');
const { addCommentForRange, nextCommentId } = require('./commentWriter');
const { applyStrikeToRange } = require('./strikeWriter');
const { ensureCommentsRegistered } = require('./manifestUpdater');

/**
 * Главный API. Применяет принятые решения к копии исходного .docx.
 *
 * decisions: [{
 *   issue,                       // строка из таблицы issues
 *   decision_kind,               // 'accept' | 'edit' | 'delete' | 'remove_from_scope'
 *   final_comment,
 *   edited_redaction,
 * }]
 *
 * meta: { author, date }
 *
 * Возвращает: { buffer, applied, skipped }
 */
function exportReviewedDocx(originalPath, decisions, meta = {}) {
  const author = meta.author || 'TZ-Opti';
  const date = meta.date ? new Date(meta.date) : new Date();

  const pkg = DocxPackage.fromFile(originalPath);
  const docDoc = pkg.getDocumentXml();
  if (!docDoc) {
    throw new Error('Не удалось прочитать word/document.xml — возможно, файл не .docx');
  }

  const paragraphs = extractParagraphs(docDoc);
  const commentsDoc = pkg.getCommentsXml();

  const applied = [];
  const skipped = [];

  for (const d of decisions) {
    const result = applyOne(d, paragraphs, commentsDoc, { author, date });
    if (result.ok) applied.push(result);
    else skipped.push(result);
  }

  pkg.saveDocumentXml();
  pkg.saveCommentsXml();
  ensureCommentsRegistered(pkg);

  return { buffer: pkg.toBuffer(), applied, skipped };
}

function applyOne(decision, paragraphs, commentsDoc, { author, date }) {
  const issue = decision.issue;
  const fragment = (issue.source_fragment || '').trim();
  if (!fragment) {
    return { ok: false, reason: 'Пустой source_fragment', issueId: issue.id };
  }

  // Сначала пытаемся попасть в paragraph_index, если он валиден
  const candidates = [];
  if (issue.paragraph_index != null && paragraphs[issue.paragraph_index]) {
    candidates.push(paragraphs[issue.paragraph_index]);
  }
  for (const p of paragraphs) candidates.push(p);

  let target = null;
  let range = null;
  for (const p of candidates) {
    const r = findFragmentInParagraph(p, fragment);
    if (r) { target = p; range = r; break; }
  }
  if (!target) {
    return { ok: false, reason: 'Фрагмент не найден в .docx', issueId: issue.id };
  }

  const splitResult = splitParagraphRuns(target, range.start, range.end);
  if (!splitResult) {
    return { ok: false, reason: 'Не удалось расщепить runs', issueId: issue.id };
  }

  const id = nextCommentId(commentsDoc);
  const text = buildCommentText(decision);
  addCommentForRange(commentsDoc, target, splitResult.firstRun, splitResult.lastRun, {
    id, author, date, text,
  });

  const kind = (decision.decision_kind || '').toString();
  if (kind === 'delete' || kind === 'remove_from_scope') {
    applyStrikeToRange(target, splitResult.firstIdx, splitResult.lastIdx);
  }

  return {
    ok: true,
    issueId: issue.id,
    commentId: id,
    decisionKind: kind || 'accept',
  };
}

function buildCommentText(decision) {
  const issue = decision.issue;
  const lines = [];
  const headerBits = [];
  if (issue.problem_type) headerBits.push(`Тип: ${ru(issue.problem_type)}`);
  if (issue.criticality) headerBits.push(`Критичность: ${ru(issue.criticality)}`);
  if (issue.analysis_stage) headerBits.push(`Стадия ${issue.analysis_stage}`);
  if (headerBits.length) lines.push(headerBits.join(' • '));

  const comment = decision.final_comment || issue.review_comment;
  if (comment) lines.push(comment);

  const redaction = decision.edited_redaction || issue.suggested_redaction;
  if (redaction) lines.push(`Предлагаемая редакция: ${redaction}`);

  if (issue.basis) lines.push(`Основание: ${issue.basis}`);

  const kind = decision.decision_kind;
  if (kind === 'delete' || kind === 'remove_from_scope') {
    lines.push('Решение: исключить из объёма работ.');
  } else if (kind === 'edit') {
    lines.push('Решение: переформулировать.');
  } else if (kind === 'accept') {
    lines.push('Решение: принять правку.');
  }

  return lines.join('\n');
}

const RU_TRANSLATIONS = {
  high: 'высокая',
  medium: 'средняя',
  low: 'низкая',
  critical: 'критическая',
};

function ru(s) {
  if (!s) return '';
  return RU_TRANSLATIONS[s] || s.replace(/_/g, ' ');
}

module.exports = { exportReviewedDocx };
