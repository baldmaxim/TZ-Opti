'use strict';

const path = require('path');
const fs = require('fs');
const db = require('../db/connection');
const { notFound, badRequest } = require('../utils/errors');
const { exportReviewedDocx } = require('../services/reviewDocx');
const exportSvc = require('../services/exportService');
const { renderReviewMd } = require('../services/mdReview/renderer');

async function getTzOriginal(tenderId) {
  // Для экспорта в .docx нужен именно .docx-файл (не .md и не .pdf).
  // Слот ТЗ может содержать оба формата параллельно — выбираем только .docx.
  return db.queryOne(
    `SELECT * FROM documents
     WHERE tender_id = ? AND doc_type = 'tz' AND LOWER(name) LIKE '%.docx'
     ORDER BY uploaded_at DESC LIMIT 1`,
    tenderId,
  );
}

async function loadDecisions(tenderId, stageFilter = null) {
  let sql = `
      SELECT i.*, d.decision as decision_kind, d.final_comment as final_comment, d.edited_redaction as edited_decision_redaction
      FROM issues i
      LEFT JOIN review_decisions d ON d.issue_id = i.id
      WHERE i.tender_id = ? AND i.selected_for_export = 1
        AND i.review_status IN ('accepted', 'edited')
  `;
  const params = [tenderId];
  if (stageFilter) {
    sql += ' AND i.analysis_stage = ?';
    params.push(stageFilter);
  }
  sql += ' ORDER BY i.analysis_stage ASC, i.paragraph_index ASC, i.char_start ASC';
  const rows = await db.queryAll(sql, ...params);
  return rows.map((r) => ({
    issue: r,
    decision_kind: r.decision_kind || (r.review_status === 'edited' ? 'edit' : 'accept'),
    final_comment: r.final_comment || r.review_comment,
    edited_redaction: r.edited_decision_redaction || r.edited_redaction,
  }));
}

exports.docx = async (req, res) => {
  const tenderId = req.params.id;
  const tender = await db.queryOne('SELECT * FROM tenders WHERE id = ?', tenderId);
  if (!tender) throw notFound('Тендер не найден');
  const tz = await getTzOriginal(tenderId);
  if (!tz) throw badRequest('В тендер не загружен документ типа «ТЗ» (.docx).');
  const ext = path.extname(tz.file_path).toLowerCase();
  if (ext !== '.docx') {
    throw badRequest('Главный экспорт поддерживает только исходный ТЗ в формате .docx. Загрузите ТЗ.docx или используйте HTML-preview.');
  }
  if (!fs.existsSync(tz.file_path)) throw notFound('Файл ТЗ отсутствует на диске');

  const stage = req.query.stage ? Number(req.query.stage) : null;
  const decisions = await loadDecisions(tenderId, stage);
  const author = (req.query.author || tender.owner || 'TZ-Opti').toString();
  const { buffer, applied, skipped } = exportReviewedDocx(tz.file_path, decisions, { author, date: new Date() });

  const safeTitle = (tender.title || 'tender').replace(/[^a-zA-Zа-яА-Я0-9_-]+/g, '_').slice(0, 60);
  const suffix = stage ? `__stage${stage}` : '';
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeTitle)}${suffix}__review.docx"`);
  res.setHeader('X-Applied-Count', String(applied.length));
  res.setHeader('X-Skipped-Count', String(skipped.length));
  res.send(buffer);
};

exports.csv = async (req, res) => {
  const csv = await exportSvc.exportIssuesCsv(req.params.id);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="issues_${req.params.id}.csv"`);
  res.send(csv);
};

exports.json = async (req, res) => {
  const json = await exportSvc.exportIssuesJson(req.params.id);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="analysis_${req.params.id}.json"`);
  res.send(json);
};

exports.summary = async (req, res) => {
  const md = await exportSvc.exportSummaryMd(req.params.id);
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="summary_${req.params.id}.md"`);
  res.send(md);
};

exports.reviewMd = async (req, res) => {
  const stage = req.query.stage ? Number(req.query.stage) : null;
  const md = await renderReviewMd(req.params.id, { stage });
  const suffix = stage ? `_stage${stage}` : '';
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="review_${req.params.id}${suffix}.md"`);
  res.send(md);
};
