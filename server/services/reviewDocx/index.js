'use strict';

const { DocxPackage } = require('./docxPackage');
const { extractParagraphs, findFragmentInParagraph, findFragmentTolerant, normalize } = require('./quoteLocator');
const { jaccardOverlap } = require('../stageAnalysis/shared/fragmentMatcher');
const { splitParagraphRuns } = require('./runSplitter');
const { addCommentForRange, addCommentForNodes, nextCommentId } = require('./commentWriter');
const { applyDeletion, applyInsertion, nextTrackChangeId } = require('./trackChangesWriter');
const { decisionVisual, resolveRedaction, resolveActionTarget } = require('../review/decisionModel');
// Удаления/правки кладутся настоящим Track Changes (w:del / w:ins). Запасной
// путь при сбое track-change — Word-комментарий (см. applyOne).
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

const FUZZY_THRESHOLD = 0.6;

// Абзацы-кандидаты: сперва указанный paragraph_index, затем все (порядок = приоритет).
function candidateParagraphs(issue, paragraphs) {
  const candidates = [];
  if (issue.paragraph_index != null && paragraphs[issue.paragraph_index]) {
    candidates.push(paragraphs[issue.paragraph_index]);
  }
  for (const p of paragraphs) candidates.push(p);
  return candidates;
}

// Одна игла по списку абзацев: сперва строго (exact) везде, потом терпимо к пробелам.
function matchNeedle(candidates, needle) {
  if (!needle) return null;
  for (const p of candidates) {
    const r = findFragmentInParagraph(p, needle);
    if (r) return { target: p, range: r };
  }
  for (const p of candidates) {
    const r = findFragmentTolerant(p, needle);
    if (r) return { target: p, range: r };
  }
  return null;
}

/**
 * Каскад локализации фрагмента в .docx с понижением точности:
 *   exact → tolerant (терпимо к пробелам) → cell (ячейки таблицы) → fuzzy (jaccard) → none.
 * `.md` (источник source_fragment) и `.docx` (цель экспорта) — разные файлы, побайтно не
 * совпадают (таблицы склеены ' | ', другие пробелы), поэтому строгого indexOf мало.
 * Возвращает { fragment, target, range, quality[, jaccard] }. `range` — РЕАЛЬНЫЕ смещения
 * в target.text. При quality 'none' target = первый непустой абзац (якорь для комментария).
 */
function locateTarget(issue, decision, paragraphs) {
  const fragment = (issue.source_fragment || '').trim();
  if (!fragment) return { fragment, target: null, range: null, quality: 'empty' };

  const candidates = candidateParagraphs(issue, paragraphs);

  // 1-2. Целый фрагмент: exact, затем tolerant.
  const whole = matchNeedle(candidates, fragment);
  if (whole) {
    const exact = findFragmentInParagraph(whole.target, fragment);
    return { fragment, target: whole.target, range: whole.range, quality: exact ? 'exact' : 'tolerant' };
  }

  // 3. Таблица по ячейкам / подчасть инженера: разбиваем строку таблицы на ячейки.
  const part = (resolveActionTarget(issue, decision) || '').trim();
  if (fragment.includes(' | ') || (part && part !== fragment)) {
    const needles = [];
    if (part && part !== fragment) needles.push(part); // выбранная инженером ячейка — приоритет
    if (fragment.includes(' | ')) {
      const cells = fragment.split(' | ').map((c) => c.trim()).filter(Boolean);
      cells.sort((a, b) => b.length - a.length); // самая содержательная ячейка — первой
      needles.push(...cells);
    }
    for (const ndl of needles) {
      const hit = matchNeedle(candidates, ndl);
      if (hit) return { fragment, target: hit.target, range: hit.range, quality: 'cell' };
    }
  }

  // 4. Нечёткий фолбэк: абзац с максимальным token-overlap (jaccard) выше порога.
  let best = null;
  let bestScore = 0;
  for (const p of candidates) {
    if (!p.text || !p.text.trim()) continue;
    const score = jaccardOverlap(fragment, p.text);
    if (score > bestScore) { bestScore = score; best = p; }
  }
  if (best && bestScore >= FUZZY_THRESHOLD) {
    return { fragment, target: best, range: { start: 0, end: best.text.length }, quality: 'fuzzy', jaccard: bestScore };
  }

  // 5. Ничего: якорь для комментария — первый непустой абзац.
  const anchor = paragraphs.find((p) => p.text && p.text.trim()) || null;
  return {
    fragment,
    target: anchor,
    range: anchor ? { start: 0, end: anchor.text.length } : null,
    quality: 'none',
  };
}

// Сужение диапазона до выбранной инженером ПОДЧАСТИ внутри найденного фрагмента.
// Поиск терпимый (как и локализация); вернёт null, если подчасть не нашлась.
function narrowToPart(target, range, part) {
  const subText = target.text.slice(range.start, range.end);
  const sub = findFragmentTolerant({ text: subText }, part);
  if (!sub) return null;
  return { start: range.start + sub.start, end: range.start + sub.end };
}

// Word-комментарий на весь абзац-якорь (фолбэк, когда правка не может лечь как track-change).
function writeComment(base, target, commentsDoc, meta, text, reason, status = 'fallback') {
  const splitResult = splitParagraphRuns(target, 0, target.text.length);
  if (!splitResult) {
    return { ...base, status: 'failed', visual: 'none', fallbackUsed: false, reason: `${reason}; не удалось расщепить абзац-якорь` };
  }
  try {
    const cid = nextCommentId(commentsDoc);
    addCommentForRange(commentsDoc, target, splitResult.firstRun, splitResult.lastRun, {
      id: cid, author: meta.author, date: meta.date, text,
    });
    return { ...base, status, visual: 'comment', fallbackUsed: status === 'fallback', commentId: cid, reason };
  } catch (err) {
    return { ...base, status: 'failed', visual: 'none', fallbackUsed: false, reason: `${reason}; комментарий не лёг: ${err.message || err}` };
  }
}

function applyOne(decision, paragraphs, commentsDoc, docDoc, { author, date }) {
  const issue = decision.issue;
  const kind = (decision.decision_kind || '').toString();
  const base = { issueId: issue.id, stage: issue.analysis_stage ?? null, decisionKind: kind };

  const loc = locateTarget(issue, decision, paragraphs);
  const { fragment, target, range, quality } = loc;
  if (!fragment) {
    return { ...base, status: 'skipped', visual: 'none', fallbackUsed: false, reason: 'Пустой source_fragment' };
  }

  const visual = decisionVisual(kind);
  const finalComment = (decision.final_comment || '').trim();

  // reject / прочее без визуала — не экспортируется (независимо от локализации).
  if (visual.docx === 'none') {
    return { ...base, status: 'skipped', visual: 'none', fallbackUsed: false, reason: 'Решение не экспортируется' };
  }

  // Место не найдено вовсе → комментарий к якорю, чтобы решение не потерялось молча.
  if (quality === 'none') {
    if (!target) {
      return { ...base, status: 'failed', visual: 'none', fallbackUsed: false, reason: 'Фрагмент не найден в .docx' };
    }
    if (visual.docx === 'comment') {
      if (!finalComment) {
        return { ...base, status: 'skipped', visual: 'comment', fallbackUsed: false, reason: 'Примечание без текста' };
      }
      return writeComment(base, target, commentsDoc, { author, date }, finalComment, 'Место не найдено — примечание оставлено комментарием');
    }
    return writeComment(base, target, commentsDoc, { author, date }, fallbackText(kind, issue, decision), 'Место не найдено — оставлено комментарием');
  }

  // Нечёткое совпадение для edit → не подменяем абзац целиком (риск), оставляем комментарий.
  if (quality === 'fuzzy' && visual.docx === 'del+ins') {
    return writeComment(
      base, target, commentsDoc, { author, date }, fallbackText(kind, issue, decision),
      `Найдено нечётко (jaccard=${(loc.jaccard || 0).toFixed(2)}) — правка оставлена комментарием`,
    );
  }

  // Сужение до выбранной инженером ПОДЧАСТИ фрагмента (delete/edit на части) —
  // только для точных/ячеечных совпадений (у fuzzy range = весь абзац).
  let effRange = range;
  let partNotFound = false;
  if (quality === 'exact' || quality === 'tolerant' || quality === 'cell') {
    const part = (resolveActionTarget(issue, decision) || '').trim();
    if (part && normalize(part) !== normalize(fragment)) {
      const narrowed = narrowToPart(target, range, part);
      if (narrowed) effRange = narrowed;
      else partNotFound = true; // подчасть не нашлась — безопасный фолбэк на весь фрагмент
    }
  }

  const splitResult = splitParagraphRuns(target, effRange.start, effRange.end);
  if (!splitResult) {
    return { ...base, status: 'failed', visual: 'none', fallbackUsed: false, reason: 'Не удалось расщепить runs' };
  }

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

    const appliedReason = partNotFound
      ? 'Выбранная подчасть не найдена — применено ко всему фрагменту'
      : (quality === 'fuzzy'
        ? `Найдено нечётко (jaccard=${(loc.jaccard || 0).toFixed(2)}) — помечен весь абзац`
        : null);
    return {
      ...base, status: 'applied', visual: visual.docx, fallbackUsed: false,
      ...(appliedReason ? { reason: appliedReason } : {}),
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
