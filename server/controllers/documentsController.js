'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../db/connection');
const { newId, nowIso } = require('../utils/ids');
const { badRequest, notFound } = require('../utils/errors');
const { extractFromFile } = require('../services/textExtractionService');

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

  await db.queryRun(
    `
    INSERT INTO documents (id, tender_id, doc_type, name, file_path, mime_type, version, uploaded_at, comment, processing_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
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
  );

  const { text, status, reason } = await extractFromFile(req.file.path, req.file.mimetype);
  await db.queryRun('UPDATE documents SET extracted_text = ?, processing_status = ? WHERE id = ?', text, status, id);

  const row = await db.queryOne(
    'SELECT id, tender_id, doc_type, name, file_path, mime_type, version, uploaded_at, comment, processing_status FROM documents WHERE id = ?',
    id,
  );
  res.status(201).json({ ...row, extraction_reason: reason || null });
};

exports.download = async (req, res) => {
  const id = req.params.id;
  const row = await db.queryOne('SELECT name, file_path, mime_type FROM documents WHERE id = ?', id);
  if (!row) throw notFound('Документ не найден');
  if (!fs.existsSync(row.file_path)) throw notFound('Файл отсутствует на диске');
  res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(row.name)}"`);
  fs.createReadStream(row.file_path).pipe(res);
};

exports.remove = async (req, res) => {
  const id = req.params.id;
  const row = await db.queryOne('SELECT file_path FROM documents WHERE id = ?', id);
  if (!row) throw notFound('Документ не найден');
  try {
    if (row.file_path && fs.existsSync(row.file_path)) fs.unlinkSync(row.file_path);
  } catch (_e) {
    /* swallow disk errors so DB stays consistent */
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
