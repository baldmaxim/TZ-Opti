'use strict';

// SHADOW-квалификация замечаний (services/qualification/qualificationShadowService).
// Тонкий контроллер: чтение оценок, решение инженера (override), повторный
// запуск gate, агрегированная статистика прогона. Ничего из production-слоёв
// (issue_clusters / review_decisions / active pointer / экспорт) не меняет.

const db = require('../db/connection');
const { notFound } = require('../utils/errors');
const svc = require('../services/qualification/qualificationShadowService');

async function ensureTender(tenderId) {
  const t = await db.queryOne('SELECT id FROM tenders WHERE id = ?', tenderId);
  if (!t) throw notFound('Тендер не найден');
}

const q = (v) => ((v || '').toString().trim() || null);

// GET /api/tenders/:id/qualification?run_id=&gate_version=
// Shadow-оценки прогона (по умолчанию — активный прогон, последняя версия gate)
// + актуальное решение инженера на каждый кластер.
exports.list = async (req, res) => {
  await ensureTender(req.params.id);
  const result = await svc.listEvaluations(req.params.id, {
    runId: q(req.query.run_id),
    gateVersion: q(req.query.gate_version),
  });
  res.json(result);
};

// GET /api/tenders/:id/qualification/clusters/:clusterId?run_id=
// Одна оценка: все версии gate + история решений инженера.
exports.get = async (req, res) => {
  await ensureTender(req.params.id);
  const result = await svc.getEvaluation(req.params.id, req.params.clusterId, {
    runId: q(req.query.run_id),
  });
  res.json(result);
};

// POST /api/tenders/:id/qualification/clusters/:clusterId/override
// body: { decision, reason_code?, final_text?, comment?, gate_version? }
// Решение инженера по shadow-оценке (append-only). Для rejected и
// accepted_with_edit reason_code обязателен (валидирует сервис).
exports.override = async (req, res) => {
  await ensureTender(req.params.id);
  const result = await svc.saveOverride(
    req.params.id, req.params.clusterId, req.body || {}, req.principal || {},
  );
  res.json(result);
};

// POST /api/tenders/:id/qualification/rerun
// body: { run_id?, gate_version? } — повторная оценка прогона (по умолчанию
// активного) заданной версией gate. Старые оценки не перезаписываются.
exports.rerun = async (req, res) => {
  await ensureTender(req.params.id);
  const body = req.body || {};
  const result = await svc.rerunGate(req.params.id, {
    runId: q(body.run_id),
    gateVersion: q(body.gate_version),
  });
  res.json(result);
};

// GET /api/tenders/:id/qualification/stats?run_id=&gate_version=
// Агрегированная статистика прогона: квалификации × решения инженера,
// false hide / false reject, причины отклонений, расхождения приоритета,
// разрезы по категориям и стадиям.
exports.stats = async (req, res) => {
  await ensureTender(req.params.id);
  const result = await svc.runStats(req.params.id, {
    runId: q(req.query.run_id),
    gateVersion: q(req.query.gate_version),
  });
  res.json(result);
};
