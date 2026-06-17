'use strict';

const xpath = require('xpath');
const { W_NS } = require('./docxPackage');

const select = xpath.useNamespaces({ w: W_NS });

function normalize(s) {
  return (s || '').toLowerCase().replace(/[ё]/g, 'е');
}

/**
 * Возвращает все параграфы документа с маппингом text↔runs.
 * Каждый параграф: { node, text, runs: [{node, text, start, end}] }
 */
function extractParagraphs(docDoc) {
  const body = select('//w:body', docDoc, true);
  if (!body) return [];
  const paragraphs = select('.//w:p', body);
  return paragraphs.map((pNode) => {
    const runs = select('.//w:r', pNode);
    let text = '';
    const runMap = [];
    for (const rNode of runs) {
      const tNodes = select('.//w:t', rNode);
      for (const tNode of tNodes) {
        const start = text.length;
        const tValue = tNode.textContent || '';
        text += tValue;
        runMap.push({
          rNode,
          tNode,
          text: tValue,
          start,
          end: start + tValue.length,
        });
      }
    }
    return { pNode, text, runs: runMap };
  });
}

function findFragmentInParagraph(paragraph, needle) {
  if (!needle) return null;
  const idx = normalize(paragraph.text).indexOf(normalize(needle));
  if (idx === -1) return null;
  return { start: idx, end: idx + needle.length };
}

// Любой пробельный символ, включая неразрывный ( ) и узкий неразрывный ( ).
function isWs(ch) {
  return /\s/.test(ch) || ch === ' ' || ch === ' ';
}

/**
 * Карта нормализации для терпимого к пробелам поиска.
 * Схлопывает каждый ран пробелов (вкл.  / /табы/переносы) в один ' ',
 * прочие символы — lowercase + ё→е (1:1). Для каждой позиции `norm` хранит
 * исходный диапазон [origStart, origEnd) в `text`, чтобы по найденному совпадению
 * вернуть РЕАЛЬНЫЕ смещения в абзаце (нужно runSplitter'у).
 */
function buildNormMap(text) {
  const s = text || '';
  const out = [];
  const origStart = [];
  const origEnd = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    if (isWs(s[i])) {
      const runStart = i;
      while (i < n && isWs(s[i])) i += 1;
      out.push(' ');
      origStart.push(runStart);
      origEnd.push(i);
    } else {
      out.push(normalize(s[i]));
      origStart.push(i);
      origEnd.push(i + 1);
      i += 1;
    }
  }
  return { norm: out.join(''), origStart, origEnd };
}

// Нормализация иглы под ту же схему (схлопывание пробелов + lowercase/ё→е + trim).
function normalizeNeedle(needle) {
  return normalize((needle || '').replace(/[\s  ]+/g, ' ')).trim();
}

/**
 * Терпимый к пробелам поиск фрагмента в абзаце.
 * Возвращает РЕАЛЬНЫЕ смещения { start, end } в paragraph.text (а не в norm),
 * поэтому результат напрямую годится для splitParagraphRuns.
 */
function findFragmentTolerant(paragraph, needle) {
  const ndl = normalizeNeedle(needle);
  if (!ndl) return null;
  const H = buildNormMap(paragraph.text);
  const idx = H.norm.indexOf(ndl);
  if (idx === -1) return null;
  const start = H.origStart[idx];
  const end = H.origEnd[idx + ndl.length - 1];
  return { start, end };
}

module.exports = {
  extractParagraphs,
  findFragmentInParagraph,
  findFragmentTolerant,
  buildNormMap,
  normalizeNeedle,
  normalize,
};
