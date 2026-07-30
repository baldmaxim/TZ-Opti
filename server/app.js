'use strict';

// Сборка Express-приложения. Модуль НИЧЕГО не делает при импорте: не слушает
// порт, не мигрирует и не сеет БД, не читает .env. Всё это — в server.js
// (единственный entrypoint). Так приложение можно собрать в тесте офлайн.
//
// Порядок middleware — это и есть модель безопасности, поэтому он расписан
// явно и менять его без причины нельзя:
//
//   1. requestContext   — X-Request-Id и IP: нить, связывающая лог, аудит и ответ;
//   2. securityHeaders  — заголовки ответа (в т.ч. на ошибки и на отдачу файлов);
//   3. corsPolicy       — allowlist источников, preflight;
//   4. rateLimit.byIp   — грубый лимит и защита от подбора токена, ДО проверки токена;
//   5. auditLogger      — вешает запись журнала на завершение ответа;
//   6. authenticate     — Bearer → principal (401);
//   7. authorize        — право роли + тенант ресурса (403);
//   8. rateLimit.byAction — лимиты дорогих действий, уже по субъекту;
//   9. body parsers     — тело разбирается ТОЛЬКО у прошедшего проверки запроса;
//  10. маршруты → 404 → errorHandler (в production без внутренних деталей).

const express = require('express');
require('express-async-errors');
const morgan = require('morgan');

const errorHandler = require('./middleware/errorHandler');
const { requestContext } = require('./middleware/requestContext');
const { securityHeaders } = require('./middleware/securityHeaders');
const { corsPolicy } = require('./middleware/corsPolicy');
const { createRateLimit } = require('./middleware/rateLimit');
const { authenticate } = require('./middleware/authenticate');
const { authorize } = require('./middleware/authorize');
const { auditLogger } = require('./middleware/auditLogger');

const { getSecurityConfig } = require('./security/config');
const { createAuthenticator } = require('./security/authenticator');
const { createTenantResolver } = require('./security/tenantAccess');
const auditService = require('./services/audit/auditService');

const tendersRouter = require('./routes/tenders');
const documentsRouter = require('./routes/documents');
const checklistRouter = require('./routes/checklist');
const conditionsRouter = require('./routes/conditions');
const risksRouter = require('./routes/risks');
const qaRouter = require('./routes/qa');
const vorRouter = require('./routes/vor');
const stagesRouter = require('./routes/stages');
const decisionsRouter = require('./routes/decisions');
const reviewRouter = require('./routes/review');
const clusterReviewRouter = require('./routes/clusterReview');
const agreedVersionsRouter = require('./routes/agreedVersions');
const qualificationRouter = require('./routes/qualification');
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
const authRouter = require('./routes/auth');
const auditRouter = require('./routes/audit');
const adminRouter = require('./routes/admin');

// Собирает приложение со всеми публичными маршрутами.
// opts.logger:   'dev' (по умолчанию) | false — отключает morgan в тестах.
// opts.security: подмена слоёв безопасности для тестов
//                { config, authenticator, tenantResolver, audit }.
function createApp({ logger = 'dev', security = {} } = {}) {
  const app = express();
  const config = security.config || getSecurityConfig();
  const authenticator = security.authenticator || createAuthenticator(config);
  const tenantResolver =
    security.tenantResolver || createTenantResolver({ defaultTenantId: config.defaultTenantId });
  const audit = security.audit || auditService;
  const rateLimit = security.rateLimit || createRateLimit(config);

  app.disable('x-powered-by');
  if (config.rateLimit.trustProxyHops > 0) app.set('trust proxy', config.rateLimit.trustProxyHops);

  app.use(requestContext({ trustProxyHops: config.rateLimit.trustProxyHops }));
  app.use(securityHeaders(config));
  app.use(corsPolicy(config));
  app.use(rateLimit.byIp);

  if (logger) {
    morgan.token('request-id', (req) => req.requestId || '-');
    morgan.token('actor', (req) => (req.principal ? req.principal.subject : '-'));
    app.use(morgan(logger === 'dev' ? ':method :url :status :response-time ms [:request-id] :actor' : logger));
  }

  // Единственный маршрут без аутентификации. Отдаёт только факт готовности —
  // ни версии, ни конфигурации, ни состояния БД.
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, ts: new Date().toISOString() });
  });

  app.use(auditLogger({ audit, config }));
  app.use(authenticate({ authenticator, devBypass: config.auth.devBypass.enabled }));
  app.use(authorize({ tenantResolver }));
  app.use(rateLimit.byAction);

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  app.use('/api', authRouter);
  app.use('/api', auditRouter);
  app.use('/api', adminRouter);
  app.use('/api', tendersRouter);
  app.use('/api', documentsRouter);
  app.use('/api', checklistRouter);
  app.use('/api', conditionsRouter);
  app.use('/api', risksRouter);
  app.use('/api', qaRouter);
  app.use('/api', vorRouter);
  app.use('/api', stagesRouter);
  app.use('/api', decisionsRouter);
  app.use('/api', reviewRouter);
  app.use('/api', clusterReviewRouter);
  app.use('/api', agreedVersionsRouter);
  app.use('/api', qualificationRouter);
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

  app.locals.security = { config, authenticator, tenantResolver, audit, rateLimit };
  return app;
}

module.exports = { createApp };
