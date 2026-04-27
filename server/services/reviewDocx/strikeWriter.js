'use strict';

const xpath = require('xpath');
const { W_NS } = require('./docxPackage');

const select = xpath.useNamespaces({ w: W_NS });

/**
 * Применяет run-property <w:strike/> и <w:color w:val="C00000"/> к runs в [firstIdx..lastIdx]
 * параграфа paragraph.
 *
 * Это не настоящий w:del (Track Changes), а визуальное вычёркивание — близкая к Word-review
 * визуализация для MVP. Контракт совместим с trackChangesWriter.
 */
function applyStrikeToRange(paragraph, firstIdx, lastIdx) {
  const doc = paragraph.pNode.ownerDocument;
  for (let i = firstIdx; i <= lastIdx; i++) {
    const run = paragraph.runs[i];
    let rPr = select('./w:rPr', run.rNode, true);
    if (!rPr) {
      rPr = doc.createElementNS(W_NS, 'w:rPr');
      // rPr должен идти первым внутри w:r
      if (run.rNode.firstChild) {
        run.rNode.insertBefore(rPr, run.rNode.firstChild);
      } else {
        run.rNode.appendChild(rPr);
      }
    }
    if (!select('./w:strike', rPr, true)) {
      const strike = doc.createElementNS(W_NS, 'w:strike');
      strike.setAttribute('w:val', 'true');
      rPr.appendChild(strike);
    }
    if (!select('./w:color', rPr, true)) {
      const color = doc.createElementNS(W_NS, 'w:color');
      color.setAttribute('w:val', 'C00000');
      rPr.appendChild(color);
    }
  }
}

module.exports = { applyStrikeToRange };
