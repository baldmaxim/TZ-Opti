'use strict';

const path = require('path');
const fs = require('fs');
const db = require('../db/connection');
const { notFound, badRequest } = require('../utils/errors');
const { exportReviewedDocx } = require('../services/reviewDocx');
const exportSvc = require('../services/exportService');

function getTzOriginal(tenderId) {
  return db
    .prepare(`SELECT * FROM documents WHERE tender_id = ? AND doc_type = 'tz' ORDER BY uploaded_at DESC LIMIT 1`)
    .get(tenderId);
}

function loadDecisions(tenderId) {
  const rows = db
    .prepare(`
      SELECT i.*, d.decision as decision_kind, d.final_comment as final_comment, d.edited_redaction as edited_decision_redaction
      FROM issues i
      LEFT JOIN review_decisions d ON d.issue_id = i.id
      WHERE i.tender_id = ? AND i.selected_for_export = 1
        AND i.review_status IN ('accepted', 'edited')
      ORDER BY i.analysis_stage ASC, i.paragraph_index ASC, i.char_start ASC
    `)
    .all(tenderId);
  return rows.map((r) => ({
    issue: r,
    decision_kind: r.decision_kind || (r.review_status === 'edited' ? 'edit' : 'accept'),
    final_comment: r.final_comment || r.review_comment,
    edited_redaction: r.edited_decision_redaction || r.edited_redaction,
  }));
}

exports.docx = (req, res) => {
  const tenderId = req.params.id;
  const tender = db.prepare('SELECT * FROM tenders WHERE id = ?').get(tenderId);
  if (!tender) throw notFound('Тендер не найден');
  const tz = getTzOriginal(tenderId);
  if (!tz) throw badRequest('В тендер не загружен документ типа «ТЗ» (.docx).');
  const ext = path.extname(tz.file_path).toLowerCase();
  if (ext !== '.docx') {
    throw badRequest('Главный экспорт поддерживает только исходный ТЗ в формате .docx. Загрузите ТЗ.docx или используйте HTML-preview.');
  }
  if (!fs.existsSync(tz.file_path)) throw notFound('Файл ТЗ отсутствует на диске');

  const decisions = loadDecisions(tenderId);
  const author = (req.query.author || tender.owner || 'TZ-Opti').toString();
  const { buffer, applied, skipped } = exportReviewedDocx(tz.file_path, decisions, { author, date: new Date() });

  const safeTitle = (tender.title || 'tender').replace(/[^a-zA-Zа-яА-Я0-9_-]+/g, '_').slice(0, 60);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeTitle)}__review.docx"`);
  res.setHeader('X-Applied-Count', String(applied.length));
  res.setHeader('X-Skipped-Count', String(skipped.length));
  res.send(buffer);
};

exports.csv = (req, res) => {
  const csv = exportSvc.exportIssuesCsv(req.params.id);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="issues_${req.params.id}.csv"`);
  res.send(csv);
};

exports.json = (req, res) => {
  const json = exportSvc.exportIssuesJson(req.params.id);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="analysis_${req.params.id}.json"`);
  res.send(json);
};

exports.summary = (req, res) => {
  const md = exportSvc.exportSummaryMd(req.params.id);
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="summary_${req.params.id}.md"`);
  res.send(md);
};
