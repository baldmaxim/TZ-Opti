'use strict';

// API структурного ВОР: позиции, сводка разбора, переимпорт и предпросмотр
// входа сопоставления ТЗ ↔ ВОР ↔ чек-лист.

const db = require('../db/connection');
const { badRequest, notFound } = require('../utils/errors');
const { getDocumentByType } = require('../services/tzActiveTextService');
const {
  importVorFile,
  loadVorItems,
  unitSummary,
} = require('../services/vor/vorImportService');
const { isSpreadsheet } = require('../services/vor/vorReader');
const { buildCatalog, catalogStats, packCatalog, renderCatalog } = require('../services/vor/vorCatalog');
const { buildMatchIndex, crossReference, selectCandidates } = require('../services/vor/vorMatchIndex');

async function requireTender(tenderId) {
  const row = await db.queryOne('SELECT id FROM tenders WHERE id = ?', tenderId);
  if (!row) throw notFound('Тендер не найден');
}

function parseReport(doc) {
  if (!doc || !doc.import_report) return null;
  try { return JSON.parse(doc.import_report); } catch (_e) { return null; }
}

// GET /api/tenders/:id/vor — позиции ведомости (с фильтром по листу/поиску).
exports.list = async (req, res) => {
  const tenderId = req.params.id;
  await requireTender(tenderId);
  const items = await loadVorItems(tenderId);
  const q = (req.query.q || '').toString().trim().toLowerCase();
  const sheet = (req.query.sheet || '').toString().trim();
  const filtered = items.filter(
    (it) =>
      (!sheet || it.sheet_name === sheet) &&
      (!q || it.name.toLowerCase().includes(q) || (it.code || '').toLowerCase().includes(q)),
  );
  res.json({
    items: filtered,
    total: items.length,
    sheets: [...new Set(items.map((i) => i.sheet_name).filter(Boolean))],
  });
};

// GET /api/tenders/:id/vor/summary — что импортировано и как разобрано.
exports.summary = async (req, res) => {
  const tenderId = req.params.id;
  await requireTender(tenderId);
  const doc = await getDocumentByType(tenderId, 'vor');
  const items = await loadVorItems(tenderId);
  const entries = buildCatalog(items);
  res.json({
    document: doc
      ? { id: doc.id, name: doc.name, uploaded_at: doc.uploaded_at, processing_status: doc.processing_status }
      : null,
    imported: items.length > 0,
    positions: items.length,
    catalog: catalogStats(entries),
    units: unitSummary(items),
    report: parseReport(doc),
  });
};

// POST /api/tenders/:id/vor/reimport — перечитать текущий файл ВОР.
exports.reimport = async (req, res) => {
  const tenderId = req.params.id;
  await requireTender(tenderId);
  const doc = await getDocumentByType(tenderId, 'vor');
  if (!doc) throw badRequest('ВОР не загружен для этого тендера');
  if (!isSpreadsheet(doc.name || doc.file_path, doc.mime_type)) {
    throw badRequest('ВОР загружен не таблицей (xls/xlsx) — структурный импорт невозможен');
  }
  const report = await importVorFile(tenderId, { documentId: doc.id, filePath: doc.file_path });
  res.json({ ok: true, report });
};

// GET /api/tenders/:id/vor/matching — структурированный вход сопоставления:
// сверка чек-лист ↔ ВОР целиком и (при ?text=…) кандидаты под кусок ТЗ.
exports.matching = async (req, res) => {
  const tenderId = req.params.id;
  await requireTender(tenderId);
  const items = await loadVorItems(tenderId);
  const checklist = await db.queryAll(
    'SELECT * FROM work_checklist_items WHERE tender_id = ?',
    tenderId,
  );
  const entries = buildCatalog(items);
  const index = buildMatchIndex({ vorEntries: entries, checklist });
  const text = (req.query.text || '').toString();
  const batches = packCatalog(entries);
  res.json({
    vor: { positions: items.length, ...catalogStats(entries), batches: batches.length },
    checklist: { total: checklist.length },
    cross_reference: entries.length && checklist.length ? crossReference(index) : null,
    candidates: text
      ? (() => {
        const c = selectCandidates(index, text);
        return {
          text_len: text.length,
          vor: c.vor.map((v) => ({ ...v.entry, score: Math.round(v.score * 100) / 100 })),
          checklist: c.checklist.map((x) => ({
            work_name: x.name,
            in_calc: x.row.in_calc,
            score: Math.round(x.score * 100) / 100,
          })),
        };
      })()
      : null,
  });
};

// GET /api/tenders/:id/vor/preview — каталог так, как его видит модель.
exports.preview = async (req, res) => {
  const tenderId = req.params.id;
  await requireTender(tenderId);
  const items = await loadVorItems(tenderId);
  const entries = buildCatalog(items);
  const batches = packCatalog(entries);
  res.type('text/markdown; charset=utf-8').send(
    batches
      .map((b) => `### Пакет ВОР ${b.index + 1}/${b.total} (${b.positions} позиций, ~${b.tokens}т)\n\n${renderCatalog(b.entries)}`)
      .join('\n\n') || '(ВОР не импортирован)',
  );
};
