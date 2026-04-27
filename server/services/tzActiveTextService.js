'use strict';

const db = require('../db/connection');

function splitParagraphs(text) {
  if (!text) return [];
  return text.split(/\r?\n/).map((s, idx) => ({ index: idx, text: s }));
}

function getTzDocument(tenderId) {
  return db
    .prepare(`SELECT * FROM documents WHERE tender_id = ? AND doc_type = 'tz' ORDER BY uploaded_at DESC LIMIT 1`)
    .get(tenderId);
}

function getDocumentByType(tenderId, docType) {
  return db
    .prepare(`SELECT * FROM documents WHERE tender_id = ? AND doc_type = ? ORDER BY uploaded_at DESC LIMIT 1`)
    .get(tenderId, docType);
}

function applyExclusions(paragraphs, ranges) {
  if (!ranges || !ranges.length) return paragraphs;
  return paragraphs.map((p) => {
    const localRanges = ranges
      .filter((r) => r.paragraph_index === p.index)
      .sort((a, b) => a.char_start - b.char_start);
    if (!localRanges.length) return p;
    let result = '';
    let cursor = 0;
    for (const r of localRanges) {
      const start = Math.max(0, Math.min(p.text.length, r.char_start));
      const end = Math.max(start, Math.min(p.text.length, r.char_end));
      if (start > cursor) result += p.text.slice(cursor, start);
      cursor = end;
    }
    if (cursor < p.text.length) result += p.text.slice(cursor);
    return { index: p.index, text: result, hadExclusion: true };
  });
}

function getActiveTzText(tenderId, beforeStage) {
  const doc = getTzDocument(tenderId);
  if (!doc) return { document: null, paragraphs: [], rawText: '', activeText: '' };
  const paragraphs = splitParagraphs(doc.extracted_text || '');
  const ranges = db
    .prepare(`SELECT * FROM tz_excluded_ranges WHERE tender_id = ? AND after_stage < ?`)
    .all(tenderId, beforeStage || 99);
  const filtered = applyExclusions(paragraphs, ranges);
  const activeText = filtered.map((p) => p.text).join('\n');
  return {
    document: doc,
    paragraphs: filtered,
    rawText: doc.extracted_text || '',
    activeText,
    excluded: ranges,
  };
}

module.exports = {
  splitParagraphs,
  getTzDocument,
  getDocumentByType,
  applyExclusions,
  getActiveTzText,
};
