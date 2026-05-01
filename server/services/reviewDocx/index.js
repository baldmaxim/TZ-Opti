'use strict';

const { DocxPackage } = require('./docxPackage');
const { extractParagraphs, findFragmentInParagraph } = require('./quoteLocator');
const { splitParagraphRuns } = require('./runSplitter');
const { addCommentForRange, nextCommentId } = require('./commentWriter');
const { applyDeletion, applyInsertion, nextTrackChangeId } = require('./trackChangesWriter');
// strikeWriter оставлен в репо как fallback/опция, но больше не вызывается —
// его место занял настоящий Track Changes (w:del / w:ins).
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
    const result = applyOne(d, paragraphs, commentsDoc, docDoc, { author, date });
    if (result.ok) applied.push(result);
    else skipped.push(result);
  }

  pkg.saveDocumentXml();
  pkg.saveCommentsXml();
  ensureCommentsRegistered(pkg);

  return { buffer: pkg.toBuffer(), applied, skipped };
}

function applyOne(decision, paragraphs, commentsDoc, docDoc, { author, date }) {
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

  const kind = (decision.decision_kind || '').toString();
  const finalComment = (decision.final_comment || '').trim();

  // 1. Word-комментарий — ТОЛЬКО для решения «Примечание» (accept) с непустым текстом
  //    (то что пользователь вручную ввёл в поле «Примечание» на странице стадии).
  //    Для delete / edit / remove_from_scope комментарий не добавляется — они
  //    обозначаются настоящим Track Changes ниже.
  let commentId = null;
  if (kind === 'accept' && finalComment) {
    commentId = nextCommentId(commentsDoc);
    addCommentForRange(commentsDoc, target, splitResult.firstRun, splitResult.lastRun, {
      id: commentId, author, date, text: finalComment,
    });
  }

  // 2. Track Changes — для delete / remove_from_scope / edit.
  // accept (Примечание) и reject (отфильтрован SQL'ем) не получают track change.
  // Оборачиваем в try/catch — поломка одного track-change не должна валить весь экспорт.
  let trackChangeError = null;
  try {
    if (kind === 'delete' || kind === 'remove_from_scope') {
      applyDeletion(target, splitResult.firstIdx, splitResult.lastIdx, {
        id: nextTrackChangeId(docDoc), author, date,
      });
    } else if (kind === 'edit') {
      // Сохраняем ссылку на rPr заменяемого фрагмента ДО переноса runs в w:del.
      const propsRun = target.runs[splitResult.lastIdx].rNode;
      const delEl = applyDeletion(target, splitResult.firstIdx, splitResult.lastIdx, {
        id: nextTrackChangeId(docDoc), author, date,
      });
      const newText = (decision.edited_redaction || '').trim();
      if (newText) {
        applyInsertion(target, delEl, newText, {
          id: nextTrackChangeId(docDoc), author, date, propsFromRun: propsRun,
        });
      }
    }
  } catch (err) {
    trackChangeError = err.message || String(err);
    console.warn(`[reviewDocx] track change skipped for issue ${issue.id}: ${trackChangeError}`);
  }

  return {
    ok: true,
    issueId: issue.id,
    commentId,
    decisionKind: kind || 'accept',
    trackChangeError,
  };
}

module.exports = { exportReviewedDocx };
