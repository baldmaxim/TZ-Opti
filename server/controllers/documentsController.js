'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../db/connection');
const { newId, nowIso } = require('../utils/ids');
const { badRequest, notFound } = require('../utils/errors');
const { extractFromFile } = require('../services/textExtractionService');
const { importQaXlsx } = require('../services/qaImportService');
const { importVorFile } = require('../services/vor/vorImportService');
const { isSpreadsheet } = require('../services/vor/vorReader');
const { UPLOAD_ROOT } = require('../middleware/upload');
const manifestService = require('../services/documents/manifestService');
const { normalizeManifestPatch, annotateDocuments } = require('../services/documents/manifestModel');

// Типы тендерного пакета: помимо входов анализа — договор, график и
// спецификации (манифест хранит их редакции/статусы для будущей междокументной
// сверки).
const ALLOWED_TYPES = [
  'tz', 'pd_rd', 'vor', 'checklist', 'company_conditions', 'risks', 'qa',
  'contract', 'schedule', 'specification', 'other',
];

exports.listForTender = async (req, res) => {
  const tenderId = req.params.id;
  const rows = await db.queryAll(
    `SELECT id, tender_id, doc_type, name, file_path, mime_type, version, uploaded_at, comment,
            processing_status, revision_label, actuality_status, doc_date, conflict_priority,
            applicability, supersedes_document_id
       FROM documents WHERE tender_id = ? ORDER BY uploaded_at DESC`,
    tenderId,
  );
  // manifest_status/superseded_by — эффективный статус с учётом обратных
  // ссылок замены (у самого документа статус мог остаться не обновлённым).
  res.json({ items: annotateDocuments(rows) });
};

// GET /api/tenders/:id/manifest — манифест тендерного пакета: группы по типам,
// статусы актуальности, цепочки замены, предупреждения разметки.
exports.getManifest = async (req, res) => {
  const tenderId = req.params.id;
  const tenderRow = await db.queryOne('SELECT id FROM tenders WHERE id = ?', tenderId);
  if (!tenderRow) throw notFound('Тендер не найден');
  res.json(await manifestService.getManifest(tenderId));
};

// PATCH /api/documents/:id/manifest — редакция / статус / дата / приоритет /
// применимость / ссылка замены.
exports.updateManifest = async (req, res) => {
  const { document, manifest } = await manifestService.updateDocumentManifest(
    req.params.id,
    req.body || {},
    { actor: req.principal || null, requestId: req.requestId || null },
  );
  res.json({ ok: true, document, manifest });
};

exports.upload = async (req, res) => {
  const tenderId = req.params.id;
  if (!req.file) throw badRequest('Файл не передан');
  const tenderRow = await db.queryOne('SELECT id FROM tenders WHERE id = ?', tenderId);
  if (!tenderRow) throw notFound('Тендер не найден');

  const docType = (req.body.doc_type || 'other').toString();
  if (!ALLOWED_TYPES.includes(docType)) throw badRequest('Недопустимый doc_type');

  const id = newId();
  const uploaded_at = nowIso();
  const version = (req.body.version || '1').toString();
  const comment = (req.body.comment || '').toString();

  // Манифест-поля можно задать сразу при загрузке (редакция, дата документа,
  // применимость к корпусу/разделу, статус). Кривое значение — 400 до записи.
  const manifestKeys = ['revision_label', 'doc_date', 'applicability', 'actuality_status', 'conflict_priority'];
  const rawManifest = {};
  for (const k of manifestKeys) if (k in req.body) rawManifest[k] = req.body[k];
  const { value: mf, errors: mfErrors } = normalizeManifestPatch(rawManifest);
  if (mfErrors.length) throw badRequest(mfErrors.join('; '));

  // Происхождение файла считает middleware/upload.js (карантин → проверки):
  // SHA-256, размер и вердикт антивируса сохраняются вместе с документом.
  const scan = req.fileScan || {};

  await db.queryRun(
    `
    INSERT INTO documents (id, tender_id, doc_type, name, file_path, mime_type, version, uploaded_at, comment, processing_status,
                           sha256, size_bytes, av_status, uploaded_by,
                           revision_label, actuality_status, doc_date, conflict_priority, applicability)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    id,
    tenderId,
    docType,
    req.file.originalname,
    req.file.path,
    req.file.mimetype || null,
    version,
    uploaded_at,
    comment,
    scan.sha256 || null,
    scan.size || null,
    scan.av_status || null,
    (req.principal && req.principal.subject) || null,
    mf.revision_label || null,
    mf.actuality_status || 'actual',
    mf.doc_date || null,
    mf.conflict_priority ?? null,
    mf.applicability || null,
  );

  const row = await db.queryOne(
    'SELECT id, tender_id, doc_type, name, file_path, mime_type, version, uploaded_at, comment, processing_status FROM documents WHERE id = ?',
    id,
  );
  res.status(201).json(row);

  setImmediate(async () => {
    try {
      if (docType === 'qa') {
        // Одношаговый импорт: новый раунд qa_imports, записи добавляются
        // diff-ом (повтор того же файла не плодит дублей). Характеристики
        // импорт НЕ трогает никогда.
        await importQaXlsx(tenderId, req.file.path, { originalName: req.file.originalname || null });
        await db.queryRun(
          `UPDATE documents SET processing_status = 'extracted' WHERE id = ?`,
          id,
        );
      } else if (docType === 'vor' && isSpreadsheet(req.file.originalname, req.file.mimetype)) {
        // ВОР-таблица разбирается СТРУКТУРНО (позиции в vor_items), а не как
        // «CSV всего листа». Текст сохраняем в любом случае: он нужен для
        // просмотра документа и остаётся фолбэком, если таблицу разобрать не
        // удалось, — неразобранный ВОР не должен выглядеть как сбой загрузки.
        const { text, status, reason } = await extractFromFile(req.file.path, req.file.mimetype);
        await db.queryRun(
          'UPDATE documents SET extracted_text = ?, processing_status = ? WHERE id = ?',
          text, status, id,
        );
        if (reason) console.warn(`[extract] doc ${id}: ${reason}`);
        try {
          const report = await importVorFile(tenderId, { documentId: id, filePath: req.file.path });
          console.log(`[extract] doc ${id}: ВОР — ${report.stats.items} позиций импортировано`);
        } catch (err) {
          console.warn(`[extract] doc ${id}: структурный разбор ВОР не удался — ${err.message}`);
          await db
            .queryRun('UPDATE documents SET import_report = ? WHERE id = ?',
              JSON.stringify({ error: err.message, imported_at: new Date().toISOString() }), id)
            .catch(() => {});
        }
      } else {
        const { text, status, reason } = await extractFromFile(req.file.path, req.file.mimetype);
        await db.queryRun(
          'UPDATE documents SET extracted_text = ?, processing_status = ? WHERE id = ?',
          text, status, id,
        );
        if (reason) console.warn(`[extract] doc ${id}: ${reason}`);
      }
    } catch (err) {
      console.error(`[extract] doc ${id} failed:`, err);
      await db
        .queryRun(`UPDATE documents SET processing_status = 'failed' WHERE id = ?`, id)
        .catch(() => {});
    }
  });
};

exports.download = async (req, res) => {
  const id = req.params.id;
  const row = await db.queryOne('SELECT name, file_path, mime_type FROM documents WHERE id = ?', id);
  if (!row) throw notFound('Документ не найден');
  // Отдаём только то, что лежит внутри каталога загрузок: file_path приходит из
  // БД, но путь наружу отдаётся файловой системе — проверка дешевле разбора,
  // как туда могла попасть строка с «..».
  const resolved = path.resolve(row.file_path);
  if (resolved !== path.resolve(UPLOAD_ROOT) && !resolved.startsWith(path.resolve(UPLOAD_ROOT) + path.sep)) {
    throw notFound('Файл отсутствует на диске');
  }
  if (!fs.existsSync(resolved)) throw notFound('Файл отсутствует на диске');
  res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(row.name)}"`);
  fs.createReadStream(resolved).pipe(res);
};

exports.remove = async (req, res) => {
  const id = req.params.id;
  const row = await db.queryOne('SELECT file_path, doc_type, tender_id FROM documents WHERE id = ?', id);
  if (!row) throw notFound('Документ не найден');
  try {
    if (row.file_path && fs.existsSync(row.file_path)) fs.unlinkSync(row.file_path);
  } catch (_e) {
    /* swallow disk errors so DB stays consistent */
  }
  // Позиции ВОР живут отдельной таблицей — удаляем вместе с документом,
  // иначе анализ продолжит сверяться с ведомостью, которой уже нет.
  if (row.doc_type === 'vor') {
    await db.queryRun('DELETE FROM vor_items WHERE tender_id = ? AND document_id = ?', row.tender_id, id);
  }
  // Ссылки замены на удаляемый документ снимаем — висячая ссылка в манифесте
  // выглядела бы как предупреждение без способа его убрать.
  await db.queryRun('UPDATE documents SET supersedes_document_id = NULL WHERE supersedes_document_id = ?', id);
  await db.queryRun('DELETE FROM documents WHERE id = ?', id);
  res.json({ ok: true });
};

exports.getExtracted = async (req, res) => {
  const id = req.params.id;
  const row = await db.queryOne('SELECT id, name, doc_type, extracted_text, processing_status FROM documents WHERE id = ?', id);
  if (!row) throw notFound('Документ не найден');
  res.json(row);
};
