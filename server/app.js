'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
require('express-async-errors');
const cors = require('cors');
const morgan = require('morgan');

const { runMigration } = require('./db/migrate');
const { runSeedIfEmpty } = require('./db/seed');
const errorHandler = require('./middleware/errorHandler');
const stageEngine = require('./services/stageAnalysis/stageAnalysisEngine');

const tendersRouter = require('./routes/tenders');
const documentsRouter = require('./routes/documents');
const checklistRouter = require('./routes/checklist');
const conditionsRouter = require('./routes/conditions');
const risksRouter = require('./routes/risks');
const qaRouter = require('./routes/qa');
const stagesRouter = require('./routes/stages');
const decisionsRouter = require('./routes/decisions');
const reviewRouter = require('./routes/review');
const exportRouter = require('./routes/export');
const setupLocksRouter = require('./routes/setupLocks');
const setupParamsRouter = require('./routes/setupParams');
const signalsRouter = require('./routes/signals');
const unifiedRouter = require('./routes/unified');

const PORT = Number(process.env.PORT) || 4000;

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

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
app.use('/api', exportRouter);
app.use('/api', setupLocksRouter);
app.use('/api', setupParamsRouter);
app.use('/api', signalsRouter);
app.use('/api', unifiedRouter);

app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'Not found', path: req.path });
  }
  next();
});

app.use(errorHandler);

(async () => {
  try {
    await runMigration();
    await runSeedIfEmpty();
    // Сброс «зомби»-статусов 'running' от прогонов, погибших при прошлом
    // рестарте/падении сервера (иначе клиент вечно крутит кольцо прогресса).
    await stageEngine.recoverOrphanedRunningStages();
    const server = app.listen(PORT, () => {
      console.log(`[tz-opti-server] listening on http://localhost:${PORT}`);
    });
    // Стадия 1 — синхронный POST на ~6-7 мин (worst ~12: бридж 600с +
    // запас openai-клиента). Node по умолчанию рвёт запрос на 5-й мин
    // (requestTimeout=300000) → в браузере «Failed to fetch». Поднимаем
    // выше всей цепочки. headersTimeout > keepAliveTimeout (рекомендация
    // Node), server.timeout=0 — без сокет-таймаута простоя (данные не
    // текут до самого ответа).
    // Цепочка таймаутов (каждый внешний > внутреннего):
    // бридж 900000 < openai-клиент 1020000 < сервер 1140000 < Vite-прокси.
    server.requestTimeout = 1140000;
    server.keepAliveTimeout = 1145000;
    server.headersTimeout = 1150000;
    server.timeout = 0;
  } catch (err) {
    console.error('[tz-opti-server] startup failed:', err);
    process.exit(1);
  }
})();
