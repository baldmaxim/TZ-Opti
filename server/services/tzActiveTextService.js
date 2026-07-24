'use strict';

const crypto = require('crypto');
const db = require('../db/connection');
const { parseMdToBlocks } = require('./mdParser');

// Активный текст ТЗ для стадий анализа.
//
// Источник — ТОЛЬКО .md-документ в слоте `doc_type='tz'`. .docx используется
// исключительно для финального экспорта с правками; для семантического анализа
// нам нужна структура (заголовки, списки, таблицы), которую mammoth теряет.
// Если .md в слоте нет — `getActiveTzText` возвращает `missingMd: true`,
// движок стадий сам отвечает 400 с понятным сообщением.
//
// Исключения (`tz_excluded_ranges`) привязаны к КОНКРЕТНОЙ ревизии документа
// (`document_revision_id`) + стабильному id узла (`node_id`) + хэшу исходного
// текста (`source_text_hash`). При загрузке новой версии ТЗ координаты
// (paragraph_index / char) съезжают, поэтому исключения прошлой ревизии НЕ
// применяются автоматически: они помечаются stale + needs_confirmation, а
// getActiveTzText берёт только исключения текущей ревизии.

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

// --- Идентификаторы ревизии / узла / текста (чистые, детерминированные) -------

function sha1(s) {
  return crypto.createHash('sha1').update(String(s == null ? '' : s)).digest('hex');
}

function normalizeText(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

// Хэш исходного текста (нормализованного по пробелам) — короткий, устойчивый к
// тривиальным отличиям в пробелах.
function hashText(s) {
  return `h_${sha1(normalizeText(s)).slice(0, 24)}`;
}

// Ревизия документа: меняется при новой загрузке (новый id) ИЛИ смене
// version/содержимого. Считается ОДИНАКОВО при записи (finishStage) и чтении
// (getActiveTzText) — по этому ключу исключения привязаны к версии ТЗ.
function computeRevisionId(doc) {
  if (!doc) return null;
  const basis = `${doc.id || ''}::${doc.version || '1'}::${hashText(doc.extracted_text || '')}`;
  return `rev_${sha1(basis).slice(0, 24)}`;
}

// Стабильный идентификатор узла (абзаца/строки) ТЗ: тип + путь заголовков +
// нормализованный текст. Не зависит от волатильного paragraph_index — переживает
// вставку/удаление соседних абзацев (пока текст самого узла не изменился).
function nodeIdFor(block) {
  if (!block) return null;
  const basis =
    `${block.type || ''}::${(block.section_path || []).join(' › ')}::${normalizeText(block.text)}`;
  return `nd_${sha1(basis).slice(0, 24)}`;
}

// --- Нормализация и слияние интервалов ---------------------------------------

// Клампит интервалы к [0,len], отбрасывает пустые, сортирует и СЛИВАЕТ
// пересекающиеся, ВЛОЖЕННЫЕ и соседние ([a,b)+[b,c)=[a,c)). Результат —
// непересекающиеся возрастающие интервалы.
function normalizeAndMerge(rawRanges, len) {
  const clamped = [];
  for (const r of rawRanges || []) {
    const start = Math.max(0, Math.min(len, Number(r.char_start)));
    const end = Math.max(0, Math.min(len, Number(r.char_end)));
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      clamped.push([start, end]);
    }
  }
  clamped.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const [s, e] of clamped) {
    const last = merged[merged.length - 1];
    // s <= last[1] покрывает и пересечение, и соседство (s == last[1]).
    if (last && s <= last[1]) {
      // Вложенный интервал: e может быть МЕНЬШЕ last[1] — не укорачиваем.
      last[1] = Math.max(last[1], e);
    } else {
      merged.push([s, e]);
    }
  }
  return merged;
}

// Применение `tz_excluded_ranges` к блокам. Координаты — `paragraph_index`
// (= block.index) + `char_start/char_end` внутри `block.text`. Интервалы
// нормализуются и сливаются заранее (normalizeAndMerge), а курсор двигается через
// Math.max(cursor, end) — так вложенные диапазоны не откатывают курсор назад и не
// возвращают в текст уже исключённые куски.
function applyExclusions(blocks, ranges) {
  if (!ranges || !ranges.length) return blocks;
  return blocks.map((b) => {
    const local = ranges.filter((r) => r.paragraph_index === b.index);
    if (!local.length) return b;
    const merged = normalizeAndMerge(local, b.text.length);
    if (!merged.length) return b;
    let result = '';
    let cursor = 0;
    for (const [start, end] of merged) {
      if (start > cursor) result += b.text.slice(cursor, start);
      cursor = Math.max(cursor, end); // курсор только вперёд — фикс вложенных диапазонов
    }
    if (cursor < b.text.length) result += b.text.slice(cursor);
    return { ...b, text: result, hadExclusion: true };
  });
}

// --- Отбор исключений по ревизии (чистые функции) ----------------------------

// Устарело ли исключение относительно ТЕКУЩЕЙ ревизии ТЗ. Из другой ревизии —
// да (координаты не валидны). Легаси-записи (revision = NULL) устаревают, если
// они посчитаны против другого документа-источника.
function isStaleAgainst(exclusion, currentRevisionId, currentDocumentId) {
  if (exclusion.stale) return false; // уже помечено
  const rev = exclusion.document_revision_id;
  if (rev != null && rev !== '') return rev !== currentRevisionId;
  return (
    currentDocumentId != null &&
    exclusion.source_document_id != null &&
    exclusion.source_document_id !== currentDocumentId
  );
}

// Какие исключения ПРИМЕНЯТЬ к текущей ревизии: не stale, до нужной стадии и
// принадлежат текущей ревизии (легаси без ревизии — по совпадению документа).
function selectApplicableExclusions(ranges, { revisionId, documentId, beforeStage } = {}) {
  const limit = beforeStage || 99;
  return (ranges || []).filter((r) => {
    if (r.stale) return false;
    if (!(Number(r.after_stage) < limit)) return false;
    const rev = r.document_revision_id;
    if (rev != null && rev !== '') return rev === revisionId;
    // Легаси-записи (revision = NULL): применимы, если это тот же документ.
    return documentId != null && r.source_document_id === documentId;
  });
}

// --- DB-обвязка ---------------------------------------------------------------

// Пометить как stale + needs_confirmation все исключения тендера, посчитанные
// против ДРУГОЙ ревизии текущего ТЗ (после загрузки новой версии). НЕ удаляет и
// НЕ применяет — инженер подтвердит перенос вручную. Идемпотентно.
async function markStaleExclusionsOnNewRevision(tenderId) {
  const doc = await getTzMdDocument(tenderId);
  if (!doc) return { marked: 0, revisionId: null };
  const revisionId = computeRevisionId(doc);
  const all = await db.queryAll(
    `SELECT * FROM tz_excluded_ranges WHERE tender_id = ? AND (stale IS NULL OR stale = 0)`,
    tenderId,
  );
  const staleIds = all.filter((r) => isStaleAgainst(r, revisionId, doc.id)).map((r) => r.id);
  if (staleIds.length) {
    const ph = staleIds.map(() => '?').join(',');
    await db.queryRun(
      `UPDATE tz_excluded_ranges SET stale = 1, needs_confirmation = 1 WHERE id IN (${ph})`,
      ...staleIds,
    );
  }
  return { marked: staleIds.length, revisionId };
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
      revisionId: null,
      missingMd: true,
    };
  }

  const rawText = doc.extracted_text || '';
  const blocks = await parseMdToBlocks(rawText);
  const revisionId = computeRevisionId(doc);

  const allRanges = await db.queryAll(
    `SELECT * FROM tz_excluded_ranges WHERE tender_id = ?`,
    tenderId,
  );

  // Исключения прошлых ревизий — помечаем stale + needs_confirmation (не применяем).
  const staleIds = allRanges
    .filter((r) => isStaleAgainst(r, revisionId, doc.id))
    .map((r) => r.id);
  if (staleIds.length) {
    const ph = staleIds.map(() => '?').join(',');
    await db.queryRun(
      `UPDATE tz_excluded_ranges SET stale = 1, needs_confirmation = 1 WHERE id IN (${ph})`,
      ...staleIds,
    );
    const staleSet = new Set(staleIds);
    for (const r of allRanges) if (staleSet.has(r.id)) { r.stale = 1; r.needs_confirmation = 1; }
  }

  const applicable = selectApplicableExclusions(allRanges, {
    revisionId,
    documentId: doc.id,
    beforeStage,
  });
  const filtered = applyExclusions(blocks, applicable);
  const activeText = filtered.map((b) => b.text).join('\n');

  return {
    document: doc,
    // Алиас `paragraphs` сохраняем для совместимости со стадиями 2-5,
    // которые работают с `{ index, text }`-формой (наши блоки расширяют её).
    paragraphs: filtered,
    blocks: filtered,
    rawText,
    activeText,
    excluded: applicable,
    revisionId,
    missingMd: false,
  };
}

module.exports = {
  getTzMdDocument,
  getDocumentByType,
  // чистое ядро (офлайн-тесты)
  hashText,
  normalizeText,
  computeRevisionId,
  nodeIdFor,
  normalizeAndMerge,
  applyExclusions,
  isStaleAgainst,
  selectApplicableExclusions,
  // DB
  markStaleExclusionsOnNewRevision,
  getActiveTzText,
};
