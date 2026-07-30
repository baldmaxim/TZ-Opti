'use strict';

const db = require('../db/connection');
const { badRequest, notFound } = require('../utils/errors');
const { newId } = require('../utils/ids');
const qaImport = require('../services/qaImportService');
const { exportQaXlsx } = require('../services/qaExportService');
const { autoLinkAll } = require('../services/qaTzLinkService');
const { populateStandardCharacteristics } = require('../services/characteristicsTemplate');

async function ensureTender(tenderId) {
  const t = await db.queryOne('SELECT id FROM tenders WHERE id = ?', tenderId);
  if (!t) throw notFound('Тендер не найден');
}

// Одношаговый импорт (без предпросмотра): все пригодные листы, раунд создаётся
// и сразу применяется. Основной путь UI — двухфазный (preview → apply ниже).
exports.import = async (req, res) => {
  if (!req.file) throw badRequest('Файл не передан');
  await ensureTender(req.params.id);
  const result = await qaImport.importQaXlsx(req.params.id, req.file.path, {
    originalName: req.file.originalname || null,
  });
  res.status(201).json({ ok: true, ...result });
};

// Фаза 1: разбор файла + diff против активных записей. Ничего не применяет —
// создаёт раунд qa_imports в статусе pending и возвращает предпросмотр.
exports.previewImport = async (req, res) => {
  if (!req.file) throw badRequest('Файл не передан');
  await ensureTender(req.params.id);
  const preview = await qaImport.previewQaImport(req.params.id, req.file.path, {
    originalName: req.file.originalname || null,
  });
  res.status(201).json(preview);
};

// Фаза 2: применить раунд. body: { sheets: ['Лист1', …] } — выбранные листы
// (по умолчанию все пригодные).
exports.applyImport = async (req, res) => {
  await ensureTender(req.params.id);
  const sheetNames = Array.isArray(req.body && req.body.sheets) ? req.body.sheets : null;
  const result = await qaImport.applyQaImport(req.params.id, req.params.importId, { sheetNames });
  res.json(result);
};

exports.discardImport = async (req, res) => {
  await ensureTender(req.params.id);
  res.json(await qaImport.discardQaImport(req.params.id, req.params.importId));
};

// Список раундов импорта (номер, дата, статус, сводка).
exports.listImports = async (req, res) => {
  await ensureTender(req.params.id);
  res.json({ items: await qaImport.listQaImports(req.params.id) });
};

exports.listQa = async (req, res) => {
  const items = await db.queryAll('SELECT * FROM qa_entries WHERE tender_id = ? ORDER BY order_idx ASC', req.params.id);
  res.json({ items });
};

// Выгрузка рабочей таблицы Q&A в .xlsx (тот же формат, что и импорт + поля разметки).
exports.exportXlsx = async (req, res) => {
  const tenderId = req.params.id;
  const tender = await db.queryOne('SELECT id FROM tenders WHERE id = ?', tenderId);
  if (!tender) throw notFound('Тендер не найден');
  const buffer = await exportQaXlsx(tenderId);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="qa_${tenderId}.xlsx"`);
  res.send(buffer);
};

exports.listCharacteristics = async (req, res) => {
  const items = await db.queryAll(
    'SELECT * FROM characteristics WHERE tender_id = ? ORDER BY sort_order ASC, name ASC',
    req.params.id,
  );
  res.json({ items });
};

const QA_PATCH_FIELDS = [
  'tz_clause',
  'tz_reflected',
  'tz_contradicts',
  'affects_calc',
  'affects_kp',
  'affects_contract',
  'affects_schedule',
  'accepted_decision',
];

exports.autoLink = async (req, res) => {
  const tenderId = req.params.id;
  const tender = await db.queryOne('SELECT id FROM tenders WHERE id = ?', tenderId);
  if (!tender) throw notFound('Тендер не найден');
  const overwrite = !!(req.body && req.body.overwrite);
  const result = await autoLinkAll(tenderId, { overwrite });
  if (result.reason === 'no_tz') {
    throw badRequest('В тендере не загружен ТЗ (doc_type=tz). Авто-привязка невозможна.');
  }
  res.json(result);
};

exports.patchQaEntry = async (req, res) => {
  const { id, entryId } = req.params;
  const existing = await db.queryOne('SELECT id, status FROM qa_entries WHERE id = ? AND tender_id = ?', entryId, id);
  if (!existing) throw notFound('Запись Q&A не найдена');
  const data = {};
  // Статус меняется инженером только между active и cancelled; superseded
  // управляется импортом (новая запись ссылается на отменяемую) и руками не ставится.
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'status')) {
    const status = String(req.body.status || '');
    if (!['active', 'cancelled'].includes(status)) {
      throw badRequest('Допустимые статусы: active, cancelled (superseded ставит импорт)');
    }
    if ((existing.status || 'active') === 'superseded') {
      throw badRequest('Запись superseded: её сменил новый ответ, статус меняется только импортом');
    }
    data.status = status;
  }
  for (const f of QA_PATCH_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(req.body || {}, f)) {
      const v = req.body[f];
      if (f === 'tz_clause' || f === 'accepted_decision') {
        data[f] = v == null ? null : String(v);
      } else {
        data[f] = v ? 1 : 0;
      }
    }
  }
  if (!Object.keys(data).length) {
    return res.json(await db.queryOne('SELECT * FROM qa_entries WHERE id = ?', entryId));
  }
  const sets = Object.keys(data)
    .map((k) => `${k} = ?`)
    .join(', ');
  await db.queryRun(`UPDATE qa_entries SET ${sets} WHERE id = ?`, ...Object.values(data), entryId);
  res.json(await db.queryOne('SELECT * FROM qa_entries WHERE id = ?', entryId));
};

exports.createCharacteristic = async (req, res) => {
  const tenderId = req.params.id;
  const tender = await db.queryOne('SELECT id FROM tenders WHERE id = ?', tenderId);
  if (!tender) throw notFound('Тендер не найден');
  const name = (req.body && req.body.name != null) ? String(req.body.name) : '';
  const value = (req.body && req.body.value != null) ? String(req.body.value) : null;
  const comment = (req.body && req.body.comment != null) ? String(req.body.comment) : null;
  if (!name.trim()) throw badRequest('Название характеристики обязательно');
  const maxRow = await db.queryOne(
    'SELECT COALESCE(MAX(sort_order), 0) AS m FROM characteristics WHERE tender_id = ?',
    tenderId,
  );
  const nextOrder = (maxRow && maxRow.m ? Number(maxRow.m) : 0) + 1;
  const id = newId();
  await db.queryRun(
    'INSERT INTO characteristics (id, tender_id, name, value, comment, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
    id, tenderId, name, value, comment, nextOrder,
  );
  res.status(201).json(await db.queryOne('SELECT * FROM characteristics WHERE id = ?', id));
};

exports.seedCharacteristics = async (req, res) => {
  const tenderId = req.params.id;
  const tender = await db.queryOne('SELECT id FROM tenders WHERE id = ?', tenderId);
  if (!tender) throw notFound('Тендер не найден');
  const inserted = await populateStandardCharacteristics(tenderId);
  res.json({ inserted });
};

exports.deleteCharacteristic = async (req, res) => {
  const id = req.params.charId;
  const existing = await db.queryOne('SELECT id FROM characteristics WHERE id = ?', id);
  if (!existing) throw notFound('Характеристика не найдена');
  await db.queryRun('DELETE FROM characteristics WHERE id = ?', id);
  res.status(204).end();
};

exports.patchCharacteristic = async (req, res) => {
  const id = req.params.charId;
  const existing = await db.queryOne('SELECT id FROM characteristics WHERE id = ?', id);
  if (!existing) throw notFound('Характеристика не найдена');
  const fields = ['name', 'value', 'source', 'comment'];
  const data = {};
  for (const f of fields) if (Object.prototype.hasOwnProperty.call(req.body || {}, f)) data[f] = req.body[f];
  if (!Object.keys(data).length) {
    return res.json(await db.queryOne('SELECT * FROM characteristics WHERE id = ?', id));
  }
  const sets = Object.keys(data)
    .map((k) => `${k} = ?`)
    .join(', ');
  await db.queryRun(`UPDATE characteristics SET ${sets} WHERE id = ?`, ...Object.values(data), id);
  res.json(await db.queryOne('SELECT * FROM characteristics WHERE id = ?', id));
};
