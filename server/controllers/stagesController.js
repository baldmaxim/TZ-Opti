'use strict';

const db = require('../db/connection');
const { badRequest, notFound } = require('../utils/errors');
const engine = require('../services/stageAnalysis/stageAnalysisEngine');

exports.getState = (req, res) => {
  const tender = db.prepare('SELECT id FROM tenders WHERE id = ?').get(req.params.id);
  if (!tender) throw notFound('Тендер не найден');
  const state = engine.getStageState(req.params.id);
  const stages = [1, 2, 3, 4].map((n) => ({
    stage: n,
    label: engine.STAGE_LABELS[n],
    status: state[`stage${n}_status`],
    summary: engine.getStageRunSummary(req.params.id, n),
  }));
  res.json({ state, stages });
};

exports.run = (req, res) => {
  const stage = Number(req.params.n);
  if (![1, 2, 3, 4].includes(stage)) throw badRequest('Допустимы стадии 1..4');
  const result = engine.runStage(req.params.id, stage);
  res.json({ ok: true, ...result });
};

exports.finish = (req, res) => {
  const stage = Number(req.params.n);
  if (![1, 2, 3, 4].includes(stage)) throw badRequest('Допустимы стадии 1..4');
  const state = engine.finishStage(req.params.id, stage);
  res.json({ ok: true, state });
};

exports.reset = (req, res) => {
  const stage = Number(req.params.n);
  if (![1, 2, 3, 4].includes(stage)) throw badRequest('Допустимы стадии 1..4');
  const state = engine.resetStage(req.params.id, stage);
  res.json({ ok: true, state });
};

exports.listIssues = (req, res) => {
  const stage = Number(req.params.n);
  const filters = {
    criticality: req.query.criticality || undefined,
    review_status: req.query.review_status || undefined,
    problem_type: req.query.problem_type || undefined,
  };
  const items = engine.listStageIssues(req.params.id, stage, filters);
  res.json({ items });
};
