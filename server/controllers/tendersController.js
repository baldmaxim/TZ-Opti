'use strict';

const db = require('../db/connection');
const { newId, nowIso } = require('../utils/ids');
const { badRequest, notFound } = require('../utils/errors');

const TENDER_FIELDS = ['title', 'customer', 'type', 'stage', 'deadline', 'owner', 'status', 'description'];

function ensureStageState(tenderId) {
  const row = db.prepare('SELECT tender_id FROM tender_stage_state WHERE tender_id = ?').get(tenderId);
  if (!row) {
    db.prepare(`
      INSERT INTO tender_stage_state (tender_id, current_stage, stage1_status, stage2_status, stage3_status, stage4_status)
      VALUES (?, 1, 'open', 'locked', 'locked', 'locked')
    `).run(tenderId);
  }
}

function getTenderById(tenderId) {
  const t = db.prepare('SELECT * FROM tenders WHERE id = ?').get(tenderId);
  if (!t) return null;
  const stage_state = db.prepare('SELECT * FROM tender_stage_state WHERE tender_id = ?').get(tenderId);
  const counts = {
    documents: db.prepare('SELECT COUNT(*) as c FROM documents WHERE tender_id = ?').get(tenderId).c,
    checklist: db.prepare('SELECT COUNT(*) as c FROM work_checklist_items WHERE tender_id = ?').get(tenderId).c,
    conditions: db.prepare('SELECT COUNT(*) as c FROM company_conditions WHERE tender_id = ?').get(tenderId).c,
    risks: db.prepare('SELECT COUNT(*) as c FROM risk_templates WHERE tender_id = ? OR is_global = 1').get(tenderId).c,
    issues_total: db.prepare('SELECT COUNT(*) as c FROM issues WHERE tender_id = ?').get(tenderId).c,
    issues_pending: db.prepare("SELECT COUNT(*) as c FROM issues WHERE tender_id = ? AND review_status = 'pending'").get(tenderId).c,
  };
  return { ...t, stage_state, counts };
}

exports.list = (req, res) => {
  const { search, status, type } = req.query;
  let sql = 'SELECT * FROM tenders WHERE 1=1';
  const params = [];
  if (search) {
    sql += ' AND (title LIKE ? OR customer LIKE ? OR description LIKE ?)';
    const like = `%${search}%`;
    params.push(like, like, like);
  }
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  if (type) {
    sql += ' AND type = ?';
    params.push(type);
  }
  sql += ' ORDER BY created_at DESC';
  const rows = db.prepare(sql).all(...params);
  const enriched = rows.map((t) => ({
    ...t,
    counts: {
      documents: db.prepare('SELECT COUNT(*) as c FROM documents WHERE tender_id = ?').get(t.id).c,
      issues_pending: db.prepare("SELECT COUNT(*) as c FROM issues WHERE tender_id = ? AND review_status = 'pending'").get(t.id).c,
    },
  }));
  res.json({ items: enriched });
};

exports.getOne = (req, res) => {
  const t = getTenderById(req.params.id);
  if (!t) throw notFound('Тендер не найден');
  res.json(t);
};

exports.create = (req, res) => {
  const body = req.body || {};
  if (!body.title || typeof body.title !== 'string') {
    throw badRequest('Поле title обязательно');
  }
  const id = newId();
  const created_at = nowIso();
  const insertCols = ['id', ...TENDER_FIELDS, 'created_at'];
  const placeholders = insertCols.map(() => '?').join(', ');
  const values = [id, ...TENDER_FIELDS.map((f) => body[f] ?? null), created_at];
  db.prepare(`INSERT INTO tenders (${insertCols.join(', ')}) VALUES (${placeholders})`).run(...values);
  ensureStageState(id);
  res.status(201).json(getTenderById(id));
};

exports.update = (req, res) => {
  const id = req.params.id;
  const existing = db.prepare('SELECT id FROM tenders WHERE id = ?').get(id);
  if (!existing) throw notFound('Тендер не найден');
  const body = req.body || {};
  const updates = [];
  const params = [];
  for (const f of TENDER_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, f)) {
      updates.push(`${f} = ?`);
      params.push(body[f]);
    }
  }
  if (!updates.length) return res.json(getTenderById(id));
  params.push(id);
  db.prepare(`UPDATE tenders SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json(getTenderById(id));
};

exports.remove = (req, res) => {
  const id = req.params.id;
  const r = db.prepare('DELETE FROM tenders WHERE id = ?').run(id);
  if (!r.changes) throw notFound('Тендер не найден');
  res.json({ ok: true });
};

exports.getTenderById = getTenderById;
exports.ensureStageState = ensureStageState;
