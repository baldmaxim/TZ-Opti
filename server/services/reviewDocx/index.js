'use strict';

const { DocxPackage } = require('./docxPackage');
const { extractParagraphs, findFragmentInParagraph, normalize } = require('./quoteLocator');
const { splitParagraphRuns } = require('./runSplitter');
const { addCommentForRange, addCommentForNodes, nextCommentId } = require('./commentWriter');
const { applyDeletion, applyInsertion, nextTrackChangeId } = require('./trackChangesWriter');
const { decisionVisual, resolveRedaction, resolveActionTarget } = require('../review/decisionModel');
// strikeWriter оставлен в репо как fallback/опция, но больше не вызывается —
// его место занял настоящий Track Changes (w:del / w:ins). Запасной путь при
// сбое track-change — Word-комментарий (см. applyOne).
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
 * Возвращает: { buffer, report }
 *   report = { summary: { total, applied, fallback, failed, skipped },
 *              items: [{ issueId, stage, decisionKind, status, visual, fallbackUsed, reason, commentId }] }
 *   status: 'applied'  — правка легла как задумано;
 *           'fallback' — track-change не лёг, оставлен Word-комментарий;
 *           'failed'   — не удалось ни правки, ни комментария;
 *           'skipped'  — нечего класть (пустой фрагмент / примечание без текста).
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

  const items = [];
  for (const d of decisions) {
    items.push(applyOne(d, paragraphs, commentsDoc, docDoc, { author, date }));
  }

  pkg.saveDocumentXml();
  pkg.saveCommentsXml();
  ensureCommentsRegistered(pkg);

  const summary = { total: items.length, applied: 0, fallback: 0, failed: 0, skipped: 0 };
  for (const it of items) {
    if (summary[it.status] != null) summary[it.status] += 1;
  }

  return { buffer: pkg.toBuffer(), report: { summary, items } };
}

// Краткий текст для fallback-комментария, если настоящий track-change не лёг.
function fallbackText(kind, issue, decision) {
  const parts = [];
  if (kind === 'edit') {
    const newText = resolveRedaction(issue, decision);
    parts.push(newText ? `Предложена замена на: «${newText}».` : 'Предложено изменить формулировку.');
  } else if (kind === 'remove_from_scope') {
    parts.push('Вынести из объёма (исключить из обязательств ГП).');
  } else {
    parts.push('Предложено удалить фрагмент.');
  }
  const note = (decision.final_comment || issue.review_comment || '').trim();
  if (note) parts.push(note);
  parts.push('(автоправка не применилась — оставлено комментарием)');
  return parts.join(' ');
}

function locateTarget(issue, paragraphs) {
  const fragment = (issue.source_fragment || '').trim();
  if (!fragment) return { fragment, target: null, range: null };
  // Сначала пытаемся попасть в paragraph_index, если он валиден.
  const candidates = [];
  if (issue.paragraph_index != null && paragraphs[issue.paragraph_index]) {
    candidates.push(paragraphs[issue.paragraph_index]);
  }
  for (const p of paragraphs) candidates.push(p);
  for (const p of candidates) {
    const r = findFragmentInParagraph(p, fragment);
    if (r) return { fragment, target: p, range: r };
  }
  return { fragment, target: null, range: null };
}

function applyOne(decision, paragraphs, commentsDoc, docDoc, { author, date }) {
  const issue = decision.issue;
  const kind = (decision.decision_kind || '').toString();
  const base = { issueId: issue.id, stage: issue.analysis_stage ?? null, decisionKind: kind };

  const { fragment, target, range } = locateTarget(issue, paragraphs);
  if (!fragment) {
    return { ...base, status: 'skipped', visual: 'none', fallbackUsed: false, reason: 'Пустой source_fragment' };
  }
  if (!target) {
    return { ...base, status: 'failed', visual: 'none', fallbackUsed: false, reason: 'Фрагмент не найден в .docx' };
  }

  // Сужение до выбранной инженером ПОДЧАСТИ фрагмента (delete/edit на части).
  // resolveActionTarget вернёт весь фрагмент, если подчасть не задана → range без изменений.
  // normalize length-preserving → индексы валидны в реальном тексте абзаца (runSplitter).
  let effRange = range;
  let partNotFound = false;
  const part = (resolveActionTarget(issue, decision) || '').trim();
  if (part && normalize(part) !== normalize(fragment)) {
    const fragNorm = normalize(target.text).slice(range.start, range.end);
    const subIdx = fragNorm.indexOf(normalize(part));
    if (subIdx !== -1) {
      effRange = { start: range.start + subIdx, end: range.start + subIdx + part.length };
    } else {
      partNotFound = true; // подчасть не нашлась — безопасный фолбэк на весь фрагмент
    }
  }

  const splitResult = splitParagraphRuns(target, effRange.start, effRange.end);
  if (!splitResult) {
    return { ...base, status: 'failed', visual: 'none', fallbackUsed: false, reason: 'Не удалось расщепить runs' };
  }

  const visual = decisionVisual(kind);
  const finalComment = (decision.final_comment || '').trim();

  // accept (Примечание) — только Word-комментарий, если есть текст.
  if (visual.docx === 'comment') {
    if (!finalComment) {
      return { ...base, status: 'skipped', visual: 'comment', fallbackUsed: false, reason: 'Примечание без текста' };
    }
    try {
      const id = nextCommentId(commentsDoc);
      addCommentForRange(commentsDoc, target, splitResult.firstRun, splitResult.lastRun, { id, author, date, text: finalComment });
      return { ...base, status: 'applied', visual: 'comment', fallbackUsed: false, commentId: id };
    } catch (err) {
      return { ...base, status: 'failed', visual: 'comment', fallbackUsed: false, reason: err.message || String(err) };
    }
  }

  // delete / remove_from_scope / edit — настоящий Track Changes.
  if (visual.docx === 'none') {
    return { ...base, status: 'skipped', visual: 'none', fallbackUsed: false, reason: 'Решение не экспортируется' };
  }
  try {
    // delEl/lastNode — элементы track-change; на них (СНАРУЖИ) анкерим комментарий,
    // чтобы commentReference не оказался внутри <w:del> (иначе Word скрыл бы примечание).
    let delEl;
    let lastNode;
    if (visual.docx === 'del+ins') {
      // Сохраняем ссылку на rPr заменяемого фрагмента ДО переноса runs в w:del.
      const propsRun = target.runs[splitResult.lastIdx].rNode;
      delEl = applyDeletion(target, splitResult.firstIdx, splitResult.lastIdx, {
        id: nextTrackChangeId(docDoc), author, date,
      });
      lastNode = delEl;
      const newText = resolveRedaction(issue, decision);
      if (newText) {
        const insEl = applyInsertion(target, delEl, newText, { id: nextTrackChangeId(docDoc), author, date, propsFromRun: propsRun });
        if (insEl) lastNode = insEl;
      }
    } else {
      // 'del' — delete и remove_from_scope.
      delEl = applyDeletion(target, splitResult.firstIdx, splitResult.lastIdx, {
        id: nextTrackChangeId(docDoc), author, date,
      });
      lastNode = delEl;
    }

    // Сопутствующий Word-комментарий к track-change. Объединяем:
    //   visual.tag      — метка «Вынесено из объёма» (для remove_from_scope);
    //   finalComment    — примечание инженера (edit/delete + примечание).
    // Анкерим ВОКРУГ <w:del>/<w:ins> (addCommentForNodes), а не на их runs —
    // иначе commentReference попал бы внутрь удаления и Word не показал бы примечание.
    // Комментарий необязателен — его сбой не валит уже применённую правку.
    const noteParts = [visual.tag, finalComment].filter(Boolean);
    if (noteParts.length) {
      try {
        const cid = nextCommentId(commentsDoc);
        addCommentForNodes(commentsDoc, delEl, lastNode, { id: cid, author, date, text: noteParts.join(' — ') });
      } catch (_e) {
        // комментарий не лёг — сама правка (w:del/w:ins) уже применена, это не критично.
      }
    }

    return {
      ...base, status: 'applied', visual: visual.docx, fallbackUsed: false,
      ...(partNotFound ? { reason: 'Выбранная подчасть не найдена — применено ко всему фрагменту' } : {}),
    };
  } catch (err) {
    // Track-change не лёг → fallback на Word-комментарий, чтобы правка не пропала молча.
    try {
      const cid = nextCommentId(commentsDoc);
      addCommentForRange(commentsDoc, target, splitResult.firstRun, splitResult.lastRun, {
        id: cid, author, date, text: fallbackText(kind, issue, decision),
      });
      return { ...base, status: 'fallback', visual: 'comment', fallbackUsed: true, commentId: cid, reason: err.message || String(err) };
    } catch (err2) {
      return {
        ...base, status: 'failed', visual: 'none', fallbackUsed: false,
        reason: `${err.message || err}; fallback-комментарий тоже не лёг: ${err2.message || err2}`,
      };
    }
  }
}

module.exports = { exportReviewedDocx };
