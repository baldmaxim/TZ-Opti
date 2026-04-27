'use strict';

const xpath = require('xpath');
const { CT_NS, REL_NS } = require('./docxPackage');

const selectCT = xpath.useNamespaces({ ct: CT_NS });
const selectRel = xpath.useNamespaces({ r: REL_NS });

const COMMENTS_CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml';
const COMMENTS_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments';

function ensureCommentsRegistered(pkg) {
  ensureContentType(pkg);
  ensureRelationship(pkg);
}

function ensureContentType(pkg) {
  const ctDoc = pkg.getContentTypesXml();
  const root = ctDoc.documentElement;
  const overrides = selectCT('//ct:Override', ctDoc);
  const exists = overrides.some((o) => o.getAttribute('PartName') === '/word/comments.xml');
  if (!exists) {
    const node = ctDoc.createElementNS(CT_NS, 'Override');
    node.setAttribute('PartName', '/word/comments.xml');
    node.setAttribute('ContentType', COMMENTS_CT);
    root.appendChild(node);
    pkg.saveContentTypesXml();
  }
}

function ensureRelationship(pkg) {
  const relsDoc = pkg.getRelsXml();
  const root = relsDoc.documentElement;
  const rels = selectRel('//r:Relationship', relsDoc);
  const exists = rels.some((r) => r.getAttribute('Type') === COMMENTS_REL_TYPE && r.getAttribute('Target') === 'comments.xml');
  if (!exists) {
    const ids = rels.map((r) => r.getAttribute('Id') || '');
    const id = nextRelId(ids);
    const node = relsDoc.createElementNS(REL_NS, 'Relationship');
    node.setAttribute('Id', id);
    node.setAttribute('Type', COMMENTS_REL_TYPE);
    node.setAttribute('Target', 'comments.xml');
    root.appendChild(node);
    pkg.saveRelsXml();
  }
}

function nextRelId(existing) {
  let max = 0;
  for (const id of existing) {
    const m = /^rId(\d+)$/.exec(id);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return `rId${max + 1}`;
}

module.exports = { ensureCommentsRegistered };
