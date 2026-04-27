'use strict';

const xpath = require('xpath');
const { W_NS } = require('./docxPackage');

const select = xpath.useNamespaces({ w: W_NS });

/**
 * Добавляет комментарий, охватывающий run-диапазон [firstRun..lastRun] в paragraph.
 * Возвращает использованный commentId.
 */
function addCommentForRange(commentsDoc, paragraph, firstRun, lastRun, { id, author, date, text }) {
  const doc = paragraph.pNode.ownerDocument;

  // commentRangeStart перед firstRun
  const startEl = doc.createElementNS(W_NS, 'w:commentRangeStart');
  startEl.setAttribute('w:id', String(id));
  firstRun.rNode.parentNode.insertBefore(startEl, firstRun.rNode);

  // commentRangeEnd после lastRun
  const endEl = doc.createElementNS(W_NS, 'w:commentRangeEnd');
  endEl.setAttribute('w:id', String(id));
  if (lastRun.rNode.nextSibling) {
    lastRun.rNode.parentNode.insertBefore(endEl, lastRun.rNode.nextSibling);
  } else {
    lastRun.rNode.parentNode.appendChild(endEl);
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

module.exports = { addCommentForRange, nextCommentId };
