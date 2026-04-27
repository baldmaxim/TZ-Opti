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

module.exports = {
  extractParagraphs,
  findFragmentInParagraph,
  normalize,
};
