'use strict';

// Middleware журнала аудита. Пишет одну запись на завершённый запрос — уже
// зная и статус ответа, и результат проверок доступа.
//
// Что попадает в журнал обязательно: изменения, запуск анализа, решения,
// выгрузки и ЛЮБОЙ отказ (401/403). Чтения пишутся по умолчанию и отключаются
// AUDIT_LOG_READS=0 (на больших списках это заметный объём) — отказы в чтении
// пишутся всегда, независимо от флага.

const { resolvePolicy, isPublicPath } = require('../security/policy');

function outcomeFor(status) {
  if (status === 401 || status === 403 || status === 429) return 'denied';
  if (status >= 500) return 'error';
  if (status >= 400) return 'error';
  return 'allowed';
}

function auditLogger({ audit, config }) {
  const enabled = config.audit.enabled;
  const logReads = config.audit.logReads;

  return function auditMiddleware(req, res, next) {
    if (!enabled || req.method === 'OPTIONS' || isPublicPath(req.path)) return next();

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        const status = res.statusCode;
        const outcome = outcomeFor(status);
        // Правило маршрута могло не дойти до req.security (отказ на
        // аутентификации) — резолвим отдельно, чтобы действие было названо.
        const policy = (req.security && req.security.policy) || resolvePolicy(req.method, req.path);
        const category = !req.principal && (status === 401 || status === 403) ? 'auth' : policy ? policy.category : 'read';

        if (outcome === 'allowed' && category === 'read' && !logReads) return;

        const principal = req.principal || null;
        const resource = (req.security && req.security.resource) || null;
        const failure = req.errorInfo || null;

        audit.record({
          requestId: req.requestId,
          tenantId: (principal && principal.tenantId) || req.tenantId || null,
          actorSub: principal ? principal.subject : null,
          actorEmail: principal ? principal.email : null,
          actorRoles: principal ? principal.roles : null,
          authMethod: principal ? principal.authMethod : null,
          action: policy ? policy.action : 'route.unmatched',
          category,
          outcome,
          resourceType: resource ? resource.type : policy ? policy.resourceType : null,
          resourceId: resource ? resource.id : null,
          tenderId: (resource && resource.tenderId) || req.tenderId || (policy && policy.params && policy.params.tenderId) || null,
          method: req.method,
          path: req.path,
          status,
          durationMs: req.startedAt ? Date.now() - req.startedAt : null,
          ip: req.clientIp,
          userAgent: req.headers['user-agent'],
          reason: failure ? `${failure.code || ''} ${failure.reason || ''}`.trim() : null,
          // Подробности, которые добавил обработчик (хэш файла, вердикт
          // антивируса, номер стадии) — см. req.auditMeta.
          meta: req.auditMeta || null,
        });
      } catch (err) {
        console.error('[audit] middleware failed:', err.message);
      }
    };

    res.on('finish', finish);
    res.on('close', finish); // клиент оборвал соединение — событие всё равно было
    next();
  };
}

module.exports = { auditLogger, outcomeFor };
