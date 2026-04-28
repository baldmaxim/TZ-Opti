'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const { runMigration } = require('./db/migrate');
const { runSeedIfEmpty } = require('./db/seed');
const errorHandler = require('./middleware/errorHandler');

const tendersRouter = require('./routes/tenders');
const documentsRouter = require('./routes/documents');
const checklistRouter = require('./routes/checklist');
const conditionsRouter = require('./routes/conditions');
const risksRouter = require('./routes/risks');
const objectInfoRouter = require('./routes/objectInfo');
const qaRouter = require('./routes/qa');
const stagesRouter = require('./routes/stages');
const decisionsRouter = require('./routes/decisions');
const reviewRouter = require('./routes/review');
const exportRouter = require('./routes/export');
const setupLocksRouter = require('./routes/setupLocks');
const setupParamsRouter = require('./routes/setupParams');

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
app.use('/api', objectInfoRouter);
app.use('/api', qaRouter);
app.use('/api', stagesRouter);
app.use('/api', decisionsRouter);
app.use('/api', reviewRouter);
app.use('/api', exportRouter);
app.use('/api', setupLocksRouter);
app.use('/api', setupParamsRouter);

app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'Not found', path: req.path });
  }
  next();
});

app.use(errorHandler);

(async () => {
  try {
    runMigration();
    runSeedIfEmpty();
    app.listen(PORT, () => {
      console.log(`[tz-opti-server] listening on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('[tz-opti-server] startup failed:', err);
    process.exit(1);
  }
})();
