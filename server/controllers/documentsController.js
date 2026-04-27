'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../db/connection');
const { newId, nowIso } = require('../utils/ids');
const { badRequest, notFound } = require('../utils/errors');
const { extractFromFile } = require('../services/textExtractionService');

const ALLOWED_TYPES = ['tz', 'pd_rd', 'vor', 'checklist', 'company_conditions', 'risks', 'object_info', 'qa', 'other'];

exports.listForTender = (req, res) => {
  const tenderId = req.params.id;
  const rows = db
    .prepare('SELECT id, tender_id, doc_type, name, file_path, mime_type, version, uploaded_at, comment, processing_status FROM documents WHERE tender_id = ? ORDER BY uploaded_at DESC')
    .all(tenderId);
  res.json({ items: rows });
};

exports.upload = async (req, res) => {
  const tenderId = req.params.id;
  if (!req.file) throw badRequest('Файл не передан');
  const tenderRow = db.prepare('SELECT id FROM tenders WHERE id = ?').get(tenderId);
  if (!tenderRow) throw notFound('Тендер не найден');

  const docType = (req.body.doc_type || 'other').toString();
  if (!ALLOWED_TYPES.includes(docType)) throw badRequest('Недопустимый doc_type');

  const id = newId();
  const uploaded_at = nowIso();
  const version = (req.body.version || '1').toString();
  const comment = (req.body.comment || '').toString();

  db.prepare(`
    INSERT INTO documents (id, tender_id, doc_type, name, file_path, mime_type, version, uploaded_at, comment, processing_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(
    id,
    tenderId,
    docType,
    req.file.originalname,
    req.file.path,
    req.file.mimetype || null,
    version,
    uploaded_at,
    comment
  );

  const { text, status, reason } = await extractFromFile(req.file.path, req.file.mimetype);
  db.prepare('UPDATE documents SET extracted_text = ?, processing_status = ? WHERE id = ?').run(
    text,
    status,
    id
  );

  const row = db.prepare('SELECT id, tender_id, doc_type, name, file_path, mime_type, version, uploaded_at, comment, processing_status FROM documents WHERE id = ?').get(id);
  res.status(201).json({ ...row, extraction_reason: reason || null });
};

exports.download = (req, res) => {
  const id = req.params.id;
  const row = db.prepare('SELECT name, file_path, mime_type FROM documents WHERE id = ?').get(id);
  if (!row) throw notFound('Документ не найден');
  if (!fs.existsSync(row.file_path)) throw notFound('Файл отсутствует на диске');
  res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${encodeURIComponent(row.name)}"`
  );
  fs.createReadStream(row.file_path).pipe(res);
};

exports.remove = (req, res) => {
  const id = req.params.id;
  const row = db.prepare('SELECT file_path FROM documents WHERE id = ?').get(id);
  if (!row) throw notFound('Документ не найден');
  try {
    if (row.file_path && fs.existsSync(row.file_path)) fs.unlinkSync(row.file_path);
  } catch (_e) {
    /* swallow disk errors so DB stays consistent */
  }
  db.prepare('DELETE FROM documents WHERE id = ?').run(id);
  res.json({ ok: true });
};

exports.getExtracted = (req, res) => {
  const id = req.params.id;
  const row = db.prepare('SELECT id, name, doc_type, extracted_text, processing_status FROM documents WHERE id = ?').get(id);
  if (!row) throw notFound('Документ не найден');
  res.json(row);
};
