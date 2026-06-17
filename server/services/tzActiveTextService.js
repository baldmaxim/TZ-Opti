'use strict';

const db = require('../db/connection');
const { parseMdToBlocks } = require('./mdParser');

// Активный текст ТЗ для стадий анализа.
//
// Источник — ТОЛЬКО .md-документ в слоте `doc_type='tz'`. .docx используется
// исключительно для финального экспорта с правками; для семантического анализа
// нам нужна структура (заголовки, списки, таблицы), которую mammoth теряет.
// Если .md в слоте нет — `getActiveTzText` возвращает `missingMd: true`,
// движок стадий сам отвечает 400 с понятным сообщением.

async function getTzMdDocument(tenderId) {
  return db.queryOne(
    `SELECT * FROM documents
     WHERE tender_id = ? AND doc_type = 'tz' AND LOWER(name) LIKE '%.md'
     ORDER BY uploaded_at DESC LIMIT 1`,
    tenderId,
  );
}

async function getDocumentByType(tenderId, docType) {
  return db.queryOne(
    `SELECT * FROM documents WHERE tender_id = ? AND doc_type = ? ORDER BY uploaded_at DESC LIMIT 1`,
    tenderId,
    docType,
  );
}

// Применение `tz_excluded_ranges` (фрагменты, исключённые из активного текста
// после решений предыдущих стадий: delete / remove_from_scope).
// Координаты — `paragraph_index` (= block.index) + `char_start/char_end` внутри `block.text`.
function applyExclusions(blocks, ranges) {
  if (!ranges || !ranges.length) return blocks;
  return blocks.map((b) => {
    const localRanges = ranges
      .filter((r) => r.paragraph_index === b.index)
      .sort((a, c) => a.char_start - c.char_start);
    if (!localRanges.length) return b;
    let result = '';
    let cursor = 0;
    for (const r of localRanges) {
      const start = Math.max(0, Math.min(b.text.length, r.char_start));
      const end = Math.max(start, Math.min(b.text.length, r.char_end));
      if (start > cursor) result += b.text.slice(cursor, start);
      cursor = end;
    }
    if (cursor < b.text.length) result += b.text.slice(cursor);
    return { ...b, text: result, hadExclusion: true };
  });
}

async function getActiveTzText(tenderId, beforeStage) {
  const doc = await getTzMdDocument(tenderId);
  if (!doc) {
    return {
      document: null,
      paragraphs: [],
      blocks: [],
      rawText: '',
      activeText: '',
      missingMd: true,
    };
  }

  const rawText = doc.extracted_text || '';
  const blocks = await parseMdToBlocks(rawText);

  const ranges = await db.queryAll(
    `SELECT * FROM tz_excluded_ranges WHERE tender_id = ? AND after_stage < ?`,
    tenderId,
    beforeStage || 99,
  );
  const filtered = applyExclusions(blocks, ranges);
  const activeText = filtered.map((b) => b.text).join('\n');

  return {
    document: doc,
    // Алиас `paragraphs` сохраняем для совместимости со стадиями 2-5,
    // которые работают с `{ index, text }`-формой (наши блоки расширяют её).
    paragraphs: filtered,
    blocks: filtered,
    rawText,
    activeText,
    excluded: ranges,
    missingMd: false,
  };
}

module.exports = {
  getTzMdDocument,
  getDocumentByType,
  applyExclusions,
  getActiveTzText,
};
