'use strict';

const db = require('../db/connection');
const { badRequest, notFound } = require('../utils/errors');
const engine = require('../services/stageAnalysis/stageAnalysisEngine');
const jobService = require('../services/jobs/jobService');

exports.getState = async (req, res) => {
  const tender = await db.queryOne('SELECT id FROM tenders WHERE id = ?', req.params.id);
  if (!tender) throw notFound('Тендер не найден');
  const state = await engine.getStageState(req.params.id);
  const stages = await Promise.all(
    [1, 2, 3, 4, 5].map(async (n) => ({
      stage: n,
      label: engine.STAGE_LABELS[n],
      status: state[`stage${n}_status`],
      summary: await engine.getStageRunSummary(req.params.id, n),
      // Прогресс по сегментам для круговой шкалы (только пока стадия считается).
      // Источник — строка задания в очереди, а не память процесса: прогресс
      // виден из любого процесса и переживает рестарт сервера.
      progress: await jobService.stageProgress(req.params.id, n),
    })),
  );
  res.json({ state, stages });
};

exports.run = async (req, res) => {
  const stage = Number(req.params.n);
  if (![1, 2, 3, 4, 5].includes(stage)) throw badRequest('Допустимы стадии 1..5');
  // Фоновый запуск: быстрые проверки (гейт стадии) кидают 400 сразу, иначе
  // задание уходит в устойчивую очередь и считается воркером. Клиент опрашивает
  // статус. Повторный запрос с тем же Idempotency-Key дубля не создаёт.
  const result = await engine.startStageBackground(req.params.id, stage, {
    idempotencyKey: req.get('Idempotency-Key') || (req.body && req.body.idempotency_key) || null,
  });
  res.status(202).json({ ok: true, ...result });
};

exports.finish = async (req, res) => {
  const stage = Number(req.params.n);
  if (![1, 2, 3, 4, 5].includes(stage)) throw badRequest('Допустимы стадии 1..5');
  const state = await engine.finishStage(req.params.id, stage);
  res.json({ ok: true, state });
};

// Сброс стадии НЕ удаляет историю (прогоны, issues, сигналы, решения остаются):
// снимаются указатели, архивируются прогоны, возвращается workflow-состояние,
// пишется событие аудита. Физическое удаление — admin-purge.
exports.reset = async (req, res) => {
  const stage = Number(req.params.n);
  if (![1, 2, 3, 4, 5].includes(stage)) throw badRequest('Допустимы стадии 1..5');
  const state = await engine.resetStage(req.params.id, stage, {
    actor: req.principal || null,
    requestId: req.requestId || null,
  });
  req.auditMeta = { stage, history_preserved: true };
  res.json({ ok: true, state });
};

// Части ТЗ этой стадии со статусом каждой (иерархическая сегментация):
// что посчитано, что взято из кэша, что упало и почему.
// ?run_id= — части КОНКРЕТНОГО прогона (история неизменяема, прогоны не
// затирают друг друга); без него — последний прогон. runs[] в ответе — список
// прогонов стадии со сводкой, чтобы можно было сравнить два подряд.
exports.listSegments = async (req, res) => {
  const stage = Number(req.params.n);
  if (![1, 2, 3, 4, 5].includes(stage)) throw badRequest('Допустимы стадии 1..5');
  const result = await engine.listStageSegments(req.params.id, stage, {
    runId: req.query.run_id || null,
  });
  res.json(result);
};

// Перезапуск ОДНОЙ части ТЗ: в LLM уйдёт только она, остальные части стадия
// возьмёт из сохранённых результатов.
exports.retrySegment = async (req, res) => {
  const stage = Number(req.params.n);
  if (![1, 2, 3, 4, 5].includes(stage)) throw badRequest('Допустимы стадии 1..5');
  const index = Number(req.params.idx);
  if (!Number.isInteger(index)) throw badRequest('Номер части должен быть целым числом');
  const result = await engine.retryStageSegment(req.params.id, stage, index, {
    idempotencyKey: req.get('Idempotency-Key') || (req.body && req.body.idempotency_key) || null,
  });
  res.status(202).json({ ok: true, ...result });
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
