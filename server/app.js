'use strict';

// Сборка Express-приложения. Модуль НИЧЕГО не делает при импорте: не слушает
// порт, не мигрирует и не сеет БД, не читает .env. Всё это — в server.js
// (единственный entrypoint). Так приложение можно собрать в тесте офлайн.

const express = require('express');
require('express-async-errors');
const cors = require('cors');

const morgan = require('morgan');

const errorHandler = require('./middleware/errorHandler');

const tendersRouter = require('./routes/tenders');
const documentsRouter = require('./routes/documents');
const checklistRouter = require('./routes/checklist');
const conditionsRouter = require('./routes/conditions');
const risksRouter = require('./routes/risks');
const qaRouter = require('./routes/qa');
const stagesRouter = require('./routes/stages');
const decisionsRouter = require('./routes/decisions');
const reviewRouter = require('./routes/review');
const clusterReviewRouter = require('./routes/clusterReview');
const exportRouter = require('./routes/export');
const setupLocksRouter = require('./routes/setupLocks');
const setupParamsRouter = require('./routes/setupParams');
const signalsRouter = require('./routes/signals');
const unifiedRouter = require('./routes/unified');
const criticRouter = require('./routes/critic');
const clusteringRouter = require('./routes/clustering');
const selfAnalysisRouter = require('./routes/selfAnalysis');
const pipelineRouter = require('./routes/pipeline');
const jobsRouter = require('./routes/jobs');

// Собирает приложение со всеми публичными маршрутами (набор не менялся).
// opts.logger: 'dev' (по умолчанию) | false — отключает morgan в тестах.
function createApp({ logger = 'dev' } = {}) {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));
  if (logger) app.use(morgan(logger));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, ts: new Date().toISOString() });
  });

  app.use('/api', tendersRouter);
  app.use('/api', documentsRouter);
  app.use('/api', checklistRouter);
  app.use('/api', conditionsRouter);
  app.use('/api', risksRouter);
  app.use('/api', qaRouter);
  app.use('/api', stagesRouter);
  app.use('/api', decisionsRouter);
  app.use('/api', reviewRouter);
  app.use('/api', clusterReviewRouter);
  app.use('/api', exportRouter);
  app.use('/api', setupLocksRouter);
  app.use('/api', setupParamsRouter);
  app.use('/api', signalsRouter);
  app.use('/api', unifiedRouter);
  app.use('/api', criticRouter);
  app.use('/api', clusteringRouter);
  app.use('/api', selfAnalysisRouter);
  app.use('/api', pipelineRouter);
  app.use('/api', jobsRouter);

  app.use((req, res, next) => {
    if (req.path.startsWith('/api')) {
      return res.status(404).json({ error: 'Not found', path: req.path });
    }
    next();
  });

  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
