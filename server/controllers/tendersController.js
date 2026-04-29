'use strict';

const db = require('../db/connection');
const { newId, nowIso } = require('../utils/ids');
const { badRequest, notFound } = require('../utils/errors');
const { STANDARD_CHECKLIST } = require('../db/standardChecklist');
const { populateStandardCharacteristics } = require('../services/characteristicsTemplate');
const { getLocksMap } = require('./setupLocksController');

const TENDER_FIELDS = ['title', 'customer', 'type', 'stage', 'deadline', 'owner', 'status', 'description'];

async function ensureStageState(tenderId) {
  const row = await db.queryOne('SELECT tender_id FROM tender_stage_state WHERE tender_id = ?', tenderId);
  if (!row) {
    await db.queryRun(
      `
      INSERT INTO tender_stage_state (tender_id, current_stage, stage1_status, stage2_status, stage3_status, stage4_status)
      VALUES (?, 1, 'open', 'locked', 'locked', 'locked')
    `,
      tenderId,
    );
  }
}

async function populateStandardChecklist(tenderId) {
  const items = STANDARD_CHECKLIST;
  await db.transaction(async (tx) => {
    for (const it of items) {
      await tx.queryRun(
        `
        INSERT INTO work_checklist_items (id, tender_id, section, work_name, in_calc, comment)
        VALUES (?, ?, ?, ?, NULL, NULL)
      `,
        newId(),
        tenderId,
        it.section,
        it.work_name,
      );
    }
  });
}

async function getTenderById(tenderId) {
  const t = await db.queryOne('SELECT * FROM tenders WHERE id = ?', tenderId);
  if (!t) return null;
  const stage_state = await db.queryOne('SELECT * FROM tender_stage_state WHERE tender_id = ?', tenderId);
  const [docs, checklist, conditions, risks, qa_entries, issues_total, issues_pending] = await Promise.all([
    db.queryOne('SELECT COUNT(*) as c FROM documents WHERE tender_id = ?', tenderId),
    db.queryOne('SELECT COUNT(*) as c FROM work_checklist_items WHERE tender_id = ?', tenderId),
    db.queryOne('SELECT COUNT(*) as c FROM company_conditions WHERE tender_id = ?', tenderId),
    db.queryOne('SELECT COUNT(*) as c FROM risk_templates WHERE tender_id = ? OR is_global = 1', tenderId),
    db.queryOne('SELECT COUNT(*) as c FROM qa_entries WHERE tender_id = ?', tenderId),
    db.queryOne('SELECT COUNT(*) as c FROM issues WHERE tender_id = ?', tenderId),
    db.queryOne("SELECT COUNT(*) as c FROM issues WHERE tender_id = ? AND review_status = 'pending'", tenderId),
  ]);
  const counts = {
    documents: docs?.c ?? 0,
    checklist: checklist?.c ?? 0,
    conditions: conditions?.c ?? 0,
    risks: risks?.c ?? 0,
    qa_entries: qa_entries?.c ?? 0,
    issues_total: issues_total?.c ?? 0,
    issues_pending: issues_pending?.c ?? 0,
  };
  const setup_locks = await getLocksMap(tenderId);
  return { ...t, stage_state, counts, setup_locks };
}

exports.list = async (req, res) => {
  const { search, status, type } = req.query;
  let sql = 'SELECT * FROM tenders WHERE 1=1';
  const params = [];
  if (search) {
    sql += ' AND (title ILIKE ? OR customer ILIKE ? OR description ILIKE ?)';
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
  const rows = await db.queryAll(sql, ...params);
  const enriched = await Promise.all(
    rows.map(async (t) => {
      const docs = await db.queryOne('SELECT COUNT(*) as c FROM documents WHERE tender_id = ?', t.id);
      const issues = await db.queryOne(
        "SELECT COUNT(*) as c FROM issues WHERE tender_id = ? AND review_status = 'pending'",
        t.id,
      );
      return {
        ...t,
        counts: {
          documents: docs?.c ?? 0,
          issues_pending: issues?.c ?? 0,
        },
      };
    }),
  );
  res.json({ items: enriched });
};

exports.getOne = async (req, res) => {
  const t = await getTenderById(req.params.id);
  if (!t) throw notFound('Тендер не найден');
  res.json(t);
};

exports.create = async (req, res) => {
  const body = req.body || {};
  if (!body.title || typeof body.title !== 'string') {
    throw badRequest('Поле title обязательно');
  }
  const id = newId();
  const created_at = nowIso();
  const insertCols = ['id', ...TENDER_FIELDS, 'created_at'];
  const placeholders = insertCols.map(() => '?').join(', ');
  const values = [id, ...TENDER_FIELDS.map((f) => body[f] ?? null), created_at];
  await db.queryRun(`INSERT INTO tenders (${insertCols.join(', ')}) VALUES (${placeholders})`, ...values);
  await ensureStageState(id);
  await populateStandardChecklist(id);
  await populateStandardCharacteristics(id);
  res.status(201).json(await getTenderById(id));
};

exports.update = async (req, res) => {
  const id = req.params.id;
  const existing = await db.queryOne('SELECT id FROM tenders WHERE id = ?', id);
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
  if (!updates.length) return res.json(await getTenderById(id));
  params.push(id);
  await db.queryRun(`UPDATE tenders SET ${updates.join(', ')} WHERE id = ?`, ...params);
  res.json(await getTenderById(id));
};

exports.remove = async (req, res) => {
  const id = req.params.id;
  const r = await db.queryRun('DELETE FROM tenders WHERE id = ?', id);
  if (!r.changes) throw notFound('Тендер не найден');
  res.json({ ok: true });
};

exports.getTenderById = getTenderById;
exports.ensureStageState = ensureStageState;
exports.populateStandardChecklist = populateStandardChecklist;
