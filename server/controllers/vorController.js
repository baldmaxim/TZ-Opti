'use strict';

// API структурного ВОР: позиции, сводка разбора, переимпорт и предпросмотр
// входа сопоставления ТЗ ↔ ВОР ↔ чек-лист.

const db = require('../db/connection');
const { badRequest, notFound } = require('../utils/errors');
const {
  importVorFile,
  loadVorItems,
  activeVorDocuments,
  unitSummary,
} = require('../services/vor/vorImportService');
const { isSpreadsheet } = require('../services/vor/vorReader');
const { buildCatalog, catalogStats, packCatalog, renderCatalog } = require('../services/vor/vorCatalog');
const { buildMatchIndex, crossReference, selectCandidates } = require('../services/vor/vorMatchIndex');
const requirementMatchService = require('../services/vor/requirementMatchService');

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
// Актуальных ВОР может быть несколько (корпуса): documents[] — все, document —
// первичный (обратная совместимость).
exports.summary = async (req, res) => {
  const tenderId = req.params.id;
  await requireTender(tenderId);
  const docs = await activeVorDocuments(tenderId);
  const items = await loadVorItems(tenderId);
  const entries = buildCatalog(items, { documents: docs });
  const brief = (d) => ({
    id: d.id, name: d.name, uploaded_at: d.uploaded_at, processing_status: d.processing_status,
    revision_label: d.revision_label || null, applicability: d.applicability || null,
    positions: items.filter((it) => it.document_id === d.id).length,
  });
  res.json({
    document: docs[0] ? brief(docs[0]) : null,
    documents: docs.map(brief),
    imported: items.length > 0,
    positions: items.length,
    catalog: catalogStats(entries),
    units: unitSummary(items),
    report: parseReport(docs[0]),
  });
};

// POST /api/tenders/:id/vor/reimport — перечитать файл(ы) ВОР. Без document_id
// в теле переимпортируются ВСЕ актуальные ВОР-таблицы тендера.
exports.reimport = async (req, res) => {
  const tenderId = req.params.id;
  await requireTender(tenderId);
  const docs = await activeVorDocuments(tenderId);
  if (!docs.length) throw badRequest('ВОР не загружен для этого тендера');
  const wantedId = (req.body && req.body.document_id) || null;
  const targets = (wantedId ? docs.filter((d) => d.id === wantedId) : docs)
    .filter((d) => isSpreadsheet(d.name || d.file_path, d.mime_type));
  if (!targets.length) {
    throw badRequest(wantedId
      ? 'Указанный документ не является актуальной ВОР-таблицей этого тендера'
      : 'ВОР загружен не таблицей (xls/xlsx) — структурный импорт невозможен');
  }
  const reports = [];
  for (const doc of targets) {
    // eslint-disable-next-line no-await-in-loop
    const report = await importVorFile(tenderId, { documentId: doc.id, filePath: doc.file_path });
    reports.push({ document_id: doc.id, name: doc.name, report });
  }
  res.json({ ok: true, report: reports[0].report, reports });
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
  const entries = buildCatalog(items, { documents: await activeVorDocuments(tenderId) });
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

// GET /api/tenders/:id/vor/requirements — карта сопоставления «требование ТЗ ↔
// позиции ВОР» актуального прогона Стадии 1 (?run_id= — конкретного) с
// подтверждениями инженера.
exports.requirements = async (req, res) => {
  const tenderId = req.params.id;
  await requireTender(tenderId);
  const runId = (req.query.run_id || '').toString().trim() || null;
  res.json(await requirementMatchService.getMatches(tenderId, { runId }));
};

// PATCH /api/tenders/:id/vor/requirements/:matchKey — решение инженера по связи
// (confirmed | rejected | adjusted + заметка; пусто — снять).
exports.confirmRequirement = async (req, res) => {
  const tenderId = req.params.id;
  await requireTender(tenderId);
  const body = req.body || {};
  const data = await requirementMatchService.setConfirmation(
    tenderId,
    (req.params.matchKey || '').toString(),
    { status: body.status ?? null, note: body.note ?? null },
    req.principal || null,
  );
  res.json({ ok: true, ...data });
};

// GET /api/tenders/:id/vor/preview — каталог так, как его видит модель.
exports.preview = async (req, res) => {
  const tenderId = req.params.id;
  await requireTender(tenderId);
  const items = await loadVorItems(tenderId);
  const entries = buildCatalog(items, { documents: await activeVorDocuments(tenderId) });
  const batches = packCatalog(entries);
  res.type('text/markdown; charset=utf-8').send(
    batches
      .map((b) => `### Пакет ВОР ${b.index + 1}/${b.total} (${b.positions} позиций, ~${b.tokens}т)\n\n${renderCatalog(b.entries)}`)
      .join('\n\n') || '(ВОР не импортирован)',
  );
};
