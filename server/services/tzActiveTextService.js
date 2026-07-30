'use strict';

const crypto = require('crypto');
const db = require('../db/connection');
const { parseMdToBlocks } = require('./mdParser');

// Текст ТЗ для стадий анализа.
//
// Источник — ТОЛЬКО .md-документ в слоте `doc_type='tz'`. .docx используется
// исключительно для финального экспорта с правками; для семантического анализа
// нам нужна структура (заголовки, списки, таблицы), которую mammoth теряет.
// Если .md в слоте нет — `getTzText` возвращает `missingMd: true`,
// движок стадий сам отвечает 400 с понятным сообщением.
//
// Вход анализа НЕИЗМЕНЯЕМ: все стадии 1–5 читают один и тот же текст, решения
// инженера на него не влияют. Влияние решений — через «согласованную версию ТЗ»
// (agreed version), которая становится НОВОЙ ревизией входа следующего раунда
// анализа. Прежний механизм tz_excluded_ranges (урезание активного текста между
// стадиями) демонтирован; таблица оставлена в БД как legacy-история.

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
// version/содержимого. По этому ключу скоуплены кэш частей и manifest прогонов.
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
// непересекающиеся возрастающие интервалы. Используется билдером согласованной
// версии для слияния операций правки.
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

// --- Чтение текста ТЗ ---------------------------------------------------------

async function getTzText(tenderId) {
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

  return {
    document: doc,
    // Алиас `paragraphs` сохраняем для совместимости со стадиями 2-5,
    // которые работают с `{ index, text }`-формой (наши блоки расширяют её).
    paragraphs: blocks,
    blocks,
    rawText,
    // Плоский текст блоков (без md-разметки) — для лексических сверок.
    activeText: blocks.map((b) => b.text).join('\n'),
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
  // DB
  getTzText,
};
