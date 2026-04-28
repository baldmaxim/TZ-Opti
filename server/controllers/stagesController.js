'use strict';

const db = require('../db/connection');
const { badRequest, notFound } = require('../utils/errors');
const engine = require('../services/stageAnalysis/stageAnalysisEngine');

exports.getState = async (req, res) => {
  const tender = await db.queryOne('SELECT id FROM tenders WHERE id = ?', req.params.id);
  if (!tender) throw notFound('Тендер не найден');
  const state = await engine.getStageState(req.params.id);
  const stages = await Promise.all(
    [1, 2, 3, 4].map(async (n) => ({
      stage: n,
      label: engine.STAGE_LABELS[n],
      status: state[`stage${n}_status`],
      summary: await engine.getStageRunSummary(req.params.id, n),
    })),
  );
  res.json({ state, stages });
};

exports.run = async (req, res) => {
  const stage = Number(req.params.n);
  if (![1, 2, 3, 4].includes(stage)) throw badRequest('Допустимы стадии 1..4');
  const result = await engine.runStage(req.params.id, stage);
  res.json({ ok: true, ...result });
};

exports.finish = async (req, res) => {
  const stage = Number(req.params.n);
  if (![1, 2, 3, 4].includes(stage)) throw badRequest('Допустимы стадии 1..4');
  const state = await engine.finishStage(req.params.id, stage);
  res.json({ ok: true, state });
};

exports.reset = async (req, res) => {
  const stage = Number(req.params.n);
  if (![1, 2, 3, 4].includes(stage)) throw badRequest('Допустимы стадии 1..4');
  const state = await engine.resetStage(req.params.id, stage);
  res.json({ ok: true, state });
};

exports.listIssues = async (req, res) => {
  const stage = Number(req.params.n);
  const filters = {
    criticality: req.query.criticality || undefined,
    review_status: req.query.review_status || undefined,
    problem_type: req.query.problem_type || undefined,
  };
  const items = await engine.listStageIssues(req.params.id, stage, filters);
  res.json({ items });
};
