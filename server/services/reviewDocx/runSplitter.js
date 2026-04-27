'use strict';

const xpath = require('xpath');
const { W_NS } = require('./docxPackage');

const select = xpath.useNamespaces({ w: W_NS });

/**
 * Разбивает w:r (runs) параграфа так, чтобы границы [start, end) совпали
 * с границами хотя бы одного run-а. Сохраняет rPr.
 *
 * Возвращает объект {paragraph, runIndices: [first, last]} с обновлёнными
 * индексами в paragraph.runs, на которые попал требуемый диапазон.
 *
 * paragraph — объект из quoteLocator.extractParagraphs (мутируется).
 */
function splitParagraphRuns(paragraph, start, end) {
  if (start >= end) return null;
  const doc = paragraph.pNode.ownerDocument;

  // Сначала split по позиции `start`
  splitAtOffset(paragraph, start, doc);
  // Затем по `end`
  splitAtOffset(paragraph, end, doc);

  // Найти диапазон runs, перекрывающий [start, end)
  const runs = paragraph.runs;
  let firstIdx = -1;
  let lastIdx = -1;
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    if (r.start >= start && r.end <= end && r.text.length > 0) {
      if (firstIdx === -1) firstIdx = i;
      lastIdx = i;
    }
  }
  if (firstIdx === -1) return null;
  return { firstRun: runs[firstIdx], lastRun: runs[lastIdx], firstIdx, lastIdx };
}

function splitAtOffset(paragraph, offset, doc) {
  const runs = paragraph.runs;
  const target = runs.find((r) => offset > r.start && offset < r.end);
  if (!target) return;

  const beforeText = target.text.slice(0, offset - target.start);
  const afterText = target.text.slice(offset - target.start);

  // Обновить существующий <w:t> на beforeText
  target.tNode.textContent = beforeText;

  // Создать копию <w:r> с afterText
  const newR = doc.createElementNS(W_NS, 'w:r');
  // Скопировать rPr (если есть)
  const rPr = select('./w:rPr', target.rNode, true);
  if (rPr) {
    newR.appendChild(rPr.cloneNode(true));
  }
  const newT = doc.createElementNS(W_NS, 'w:t');
  newT.setAttribute('xml:space', 'preserve');
  newT.textContent = afterText;
  newR.appendChild(newT);

  // Вставить новый run сразу после исходного
  if (target.rNode.nextSibling) {
    target.rNode.parentNode.insertBefore(newR, target.rNode.nextSibling);
  } else {
    target.rNode.parentNode.appendChild(newR);
  }

  // Обновить map runs параграфа: пересобрать
  rebuildRunMap(paragraph);
}

function rebuildRunMap(paragraph) {
  const runs = select('.//w:r', paragraph.pNode);
  let pos = 0;
  const out = [];
  let textBuffer = '';
  for (const rNode of runs) {
    const tNodes = select('.//w:t', rNode);
    for (const tNode of tNodes) {
      const tValue = tNode.textContent || '';
      out.push({
        rNode,
        tNode,
        text: tValue,
        start: pos,
        end: pos + tValue.length,
      });
      pos += tValue.length;
      textBuffer += tValue;
    }
  }
  paragraph.runs = out;
  paragraph.text = textBuffer;
}

module.exports = {
  splitParagraphRuns,
  rebuildRunMap,
};
