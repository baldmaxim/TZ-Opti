'use strict';

const db = require('../db/connection');
const { notFound } = require('../utils/errors');
const signalWriter = require('../services/signals/signalWriter');

async function ensureTender(tenderId) {
  const t = await db.queryOne('SELECT id FROM tenders WHERE id = ?', tenderId);
  if (!t) throw notFound('Тендер не найден');
}

function safeParse(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch (_e) { return null; }
}

// GET /api/tenders/:id/signals?signal_type=coverage|decision|condition|risk
exports.list = async (req, res) => {
  await ensureTender(req.params.id);
  const signalType = req.query.signal_type || req.query.type || null;
  const rows = await signalWriter.listSignals(req.params.id, { signalType });
  const items = rows.map((r) => ({ ...r, signal_payload: safeParse(r.signal_payload_json) }));
  // Сводка по типам — удобно для debug-вкладки.
  const byType = items.reduce((acc, s) => {
    acc[s.signal_type] = (acc[s.signal_type] || 0) + 1;
    return acc;
  }, {});
  res.json({ items, count: items.length, by_type: byType });
};
