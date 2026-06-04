'use strict';

const xpath = require('xpath');
const { W_NS } = require('./docxPackage');

const select = xpath.useNamespaces({ w: W_NS });

/**
 * Добавляет комментарий, охватывающий узлы [firstNode..lastNode] (на уровне абзаца).
 * Маркеры (commentRangeStart/End и run с commentReference) ставятся как СОСЕДИ
 * этих узлов — НЕ внутри них. Это важно для track-change: если анкерить на runs,
 * которые applyDeletion уже перенёс внутрь <w:del>, то commentReference окажется
 * внутри удаления, и Word посчитает сам комментарий удалённым (не покажет его).
 * Поэтому для del/ins анкеримся на элементы <w:del>/<w:ins>, а не на их runs.
 * Возвращает использованный commentId.
 */
function addCommentForNodes(commentsDoc, firstNode, lastNode, { id, author, date, text }) {
  const doc = firstNode.ownerDocument;

  // commentRangeStart перед firstNode
  const startEl = doc.createElementNS(W_NS, 'w:commentRangeStart');
  startEl.setAttribute('w:id', String(id));
  firstNode.parentNode.insertBefore(startEl, firstNode);

  // commentRangeEnd после lastNode
  const endEl = doc.createElementNS(W_NS, 'w:commentRangeEnd');
  endEl.setAttribute('w:id', String(id));
  if (lastNode.nextSibling) {
    lastNode.parentNode.insertBefore(endEl, lastNode.nextSibling);
  } else {
    lastNode.parentNode.appendChild(endEl);
  }

  // run с reference сразу после commentRangeEnd
  const refRun = doc.createElementNS(W_NS, 'w:r');
  const refRPr = doc.createElementNS(W_NS, 'w:rPr');
  const rStyle = doc.createElementNS(W_NS, 'w:rStyle');
  rStyle.setAttribute('w:val', 'CommentReference');
  refRPr.appendChild(rStyle);
  refRun.appendChild(refRPr);
  const refEl = doc.createElementNS(W_NS, 'w:commentReference');
  refEl.setAttribute('w:id', String(id));
  refRun.appendChild(refEl);
  if (endEl.nextSibling) {
    endEl.parentNode.insertBefore(refRun, endEl.nextSibling);
  } else {
    endEl.parentNode.appendChild(refRun);
  }

  // запись в comments.xml
  const commentsRoot = commentsDoc.documentElement;
  const c = commentsDoc.createElementNS(W_NS, 'w:comment');
  c.setAttribute('w:id', String(id));
  c.setAttribute('w:author', author || 'TZ-Opti');
  c.setAttribute('w:initials', initialsFor(author));
  c.setAttribute('w:date', (date || new Date()).toISOString ? (date || new Date()).toISOString() : new Date(date || Date.now()).toISOString());

  // <w:p><w:r><w:t>текст</w:t></w:r></w:p>
  const lines = (text || '').split(/\r?\n/);
  for (const line of lines) {
    const p = commentsDoc.createElementNS(W_NS, 'w:p');
    const r = commentsDoc.createElementNS(W_NS, 'w:r');
    const t = commentsDoc.createElementNS(W_NS, 'w:t');
    t.setAttribute('xml:space', 'preserve');
    t.textContent = line;
    r.appendChild(t);
    p.appendChild(r);
    c.appendChild(p);
  }
  commentsRoot.appendChild(c);

  return id;
}

/**
 * Комментарий на run-диапазон [firstRun..lastRun] (для решений БЕЗ track-change:
 * accept-«Примечание» и fallback). Делегирует в addCommentForNodes по rNode.
 */
function addCommentForRange(commentsDoc, paragraph, firstRun, lastRun, opts) {
  return addCommentForNodes(commentsDoc, firstRun.rNode, lastRun.rNode, opts);
}

function nextCommentId(commentsDoc) {
  const list = select('//w:comment', commentsDoc);
  let max = -1;
  for (const c of list) {
    const v = parseInt(c.getAttribute('w:id') || '-1', 10);
    if (!Number.isNaN(v) && v > max) max = v;
  }
  return max + 1;
}

function initialsFor(author) {
  if (!author) return 'TZ';
  const parts = author.trim().split(/\s+/);
  return parts.map((p) => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || 'TZ';
}

module.exports = { addCommentForRange, addCommentForNodes, nextCommentId };
