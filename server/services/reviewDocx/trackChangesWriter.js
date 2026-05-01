'use strict';

const xpath = require('xpath');
const { W_NS } = require('./docxPackage');

const select = xpath.useNamespaces({ w: W_NS });

/**
 * Настоящий Word Track Changes (`w:ins` / `w:del`).
 *
 * Контракт совместим с strikeWriter / commentWriter — встраивается в pipeline
 * `index.js → applyOne()` без изменения структуры.
 */

/**
 * Помечает runs в [firstIdx..lastIdx] как удалённые в режиме рецензии.
 * Внутри каждого run переименовывает `w:t` → `w:delText`, затем оборачивает
 * runs в общий `<w:del>`-элемент с автором/датой.
 *
 * Возвращает созданный `<w:del>`-элемент (нужен для applyInsertion при `edit`).
 */
function applyDeletion(paragraph, firstIdx, lastIdx, { id, author, date }) {
  const pNode = paragraph.pNode;
  const doc = pNode.ownerDocument;
  const runs = paragraph.runs;

  if (firstIdx > lastIdx || firstIdx < 0 || lastIdx >= runs.length) {
    throw new Error(`applyDeletion: некорректный диапазон [${firstIdx}..${lastIdx}] при runs.length=${runs.length}`);
  }

  // 1. Создать <w:del> с атрибутами.
  const del = doc.createElementNS(W_NS, 'w:del');
  del.setAttribute('w:id', String(id));
  del.setAttribute('w:author', author || 'TZ-Opti');
  del.setAttribute('w:date', toIsoDate(date));

  // 2. Внутри каждого run переименовать <w:t> в <w:delText>.
  for (let i = firstIdx; i <= lastIdx; i++) {
    convertTextToDelText(runs[i].rNode, doc);
  }

  // 3. Вставить <w:del> перед первым run В ЕГО ТЕКУЩЕМ РОДИТЕЛЕ.
  // Run уже мог быть перенесён в другой w:del/w:ins предыдущей итерацией —
  // используем фактический parentNode, а не pNode.
  const firstRunNode = runs[firstIdx].rNode;
  const parent = firstRunNode.parentNode || pNode;
  parent.insertBefore(del, firstRunNode);

  // 4. Перенести runs внутрь <w:del> (appendChild автоматически удаляет из старого parent).
  for (let i = firstIdx; i <= lastIdx; i++) {
    del.appendChild(runs[i].rNode);
  }

  return del;
}

/**
 * Вставляет новый текст в режиме рецензии после `afterNode` в его родителе.
 * Используется для `edit` сразу после applyDeletion (afterNode = возвращённый <w:del>).
 *
 * Если задан `propsFromRun`, копирует его `<w:rPr>` для наследования форматирования.
 */
function applyInsertion(paragraph, afterNode, newText, { id, author, date, propsFromRun }) {
  const doc = paragraph.pNode.ownerDocument;
  const parent = afterNode.parentNode;

  // 1. Создать <w:ins>.
  const ins = doc.createElementNS(W_NS, 'w:ins');
  ins.setAttribute('w:id', String(id));
  ins.setAttribute('w:author', author || 'TZ-Opti');
  ins.setAttribute('w:date', toIsoDate(date));

  // 2. Создать <w:r> с опциональным <w:rPr> от исходного run.
  const r = doc.createElementNS(W_NS, 'w:r');
  if (propsFromRun) {
    const srcRPr = select('./w:rPr', propsFromRun, true);
    if (srcRPr) r.appendChild(srcRPr.cloneNode(true));
  }

  // 3. <w:t xml:space="preserve">newText</w:t>.
  const t = doc.createElementNS(W_NS, 'w:t');
  t.setAttribute('xml:space', 'preserve');
  t.textContent = newText;
  r.appendChild(t);

  ins.appendChild(r);

  // 4. Вставить <w:ins> сразу после afterNode.
  if (afterNode.nextSibling) {
    parent.insertBefore(ins, afterNode.nextSibling);
  } else {
    parent.appendChild(ins);
  }

  return ins;
}

/**
 * Переименовывает все `<w:t>` дети run-элемента в `<w:delText>`.
 * Имя элемента в Word XML определяет, считать ли текст удалённым внутри `<w:del>`.
 * Атрибуты (включая xml:space) и содержимое сохраняются.
 */
function convertTextToDelText(rNode, doc) {
  const tNodes = select('./w:t', rNode);
  for (const tNode of tNodes) {
    const delText = doc.createElementNS(W_NS, 'w:delText');
    // Скопировать атрибуты.
    if (tNode.attributes) {
      for (let i = 0; i < tNode.attributes.length; i++) {
        const attr = tNode.attributes.item(i);
        delText.setAttribute(attr.name, attr.value);
      }
    }
    // Перенести дочерние ноды (текст).
    while (tNode.firstChild) {
      delText.appendChild(tNode.firstChild);
    }
    tNode.parentNode.replaceChild(delText, tNode);
  }
}

/**
 * Возвращает следующий уникальный id для w:ins / w:del в документе.
 * Сканирует все существующие <w:ins> и <w:del>, берёт max(@w:id) + 1.
 * Гарантия уникальности при последовательной обработке нескольких issues —
 * каждый вызов видит уже добавленные предыдущей итерацией элементы.
 */
function nextTrackChangeId(docDoc) {
  const list = [
    ...select('//w:ins', docDoc),
    ...select('//w:del', docDoc),
  ];
  let max = -1;
  for (const node of list) {
    const v = parseInt(node.getAttribute('w:id') || '-1', 10);
    if (!Number.isNaN(v) && v > max) max = v;
  }
  return max + 1;
}

function toIsoDate(date) {
  if (!date) return new Date().toISOString();
  if (date instanceof Date) return date.toISOString();
  return new Date(date).toISOString();
}

module.exports = {
  applyDeletion,
  applyInsertion,
  nextTrackChangeId,
};
