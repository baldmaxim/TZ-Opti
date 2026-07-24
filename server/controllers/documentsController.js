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
const { markStaleExclusionsOnNewRevision } = require('../services/tzActiveTextService');
const { UPLOAD_ROOT } = require('../middleware/upload');

const ALLOWED_TYPES = ['tz', 'pd_rd', 'vor', 'checklist', 'company_conditions', 'risks', 'qa', 'other'];

exports.listForTender = async (req, res) => {
  const tenderId = req.params.id;
  const rows = await db.queryAll(
    'SELECT id, tender_id, doc_type, name, file_path, mime_type, version, uploaded_at, comment, processing_status FROM documents WHERE tender_id = ? ORDER BY uploaded_at DESC',
    tenderId,
  );
  res.json({ items: rows });
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

  // Происхождение файла считает middleware/upload.js (карантин → проверки):
  // SHA-256, размер и вердикт антивируса сохраняются вместе с документом.
  const scan = req.fileScan || {};

  await db.queryRun(
    `
    INSERT INTO documents (id, tender_id, doc_type, name, file_path, mime_type, version, uploaded_at, comment, processing_status,
                           sha256, size_bytes, av_status, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
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
  );

  const row = await db.queryOne(
    'SELECT id, tender_id, doc_type, name, file_path, mime_type, version, uploaded_at, comment, processing_status FROM documents WHERE id = ?',
    id,
  );
  res.status(201).json(row);

  setImmediate(async () => {
    try {
      if (docType === 'qa') {
        await importQaXlsx(tenderId, req.file.path);
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
        // Загрузка новой версии ТЗ (.md): исключения прошлых ревизий больше не
        // валидны по координатам — помечаем stale + needs_confirmation, но НЕ
        // применяем автоматически (инженер подтвердит перенос).
        if (docType === 'tz' && /\.md$/i.test(req.file.originalname || '')) {
          const res = await markStaleExclusionsOnNewRevision(tenderId);
          if (res.marked) console.log(`[extract] doc ${id}: ${res.marked} исключений помечено stale (новая ревизия ТЗ)`);
        }
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
  await db.queryRun('DELETE FROM documents WHERE id = ?', id);
  res.json({ ok: true });
};

exports.getExtracted = async (req, res) => {
  const id = req.params.id;
  const row = await db.queryOne('SELECT id, name, doc_type, extracted_text, processing_status FROM documents WHERE id = ?', id);
  if (!row) throw notFound('Документ не найден');
  res.json(row);
};
