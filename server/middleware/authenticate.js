'use strict';

// Аутентификация: Bearer-токен → req.principal. Ни один /api-маршрут, кроме
// явно публичных (security/policy.js → PUBLIC_PATHS), дальше без principal не
// проходит.
//
// Токен принимается ТОЛЬКО из заголовка Authorization. Ни query-параметр
// (?access_token=…), ни cookie не поддерживаются сознательно: query попадает в
// логи прокси и в историю браузера, cookie тянет за собой CSRF.

const { unauthorized, forbidden } = require('../utils/errors');
const { isPublicPath } = require('../security/policy');

const BEARER = /^Bearer[ ]+([A-Za-z0-9._~+/=-]+)$/;

function extractBearer(req) {
  const header = req.headers.authorization;
  if (!header || typeof header !== 'string') return null;
  const m = BEARER.exec(header.trim());
  return m ? m[1] : null;
}

// authenticator — security/authenticator.js (или подмена в тестах).
function authenticate({ authenticator, devBypass = false }) {
  return async function authenticateMiddleware(req, res, next) {
    if (req.method === 'OPTIONS' || isPublicPath(req.path)) return next();

    // Dev-bypass: только вне production (проверено дважды — в конфигурации при
    // сборке и здесь при выдаче principal).
    if (devBypass && authenticator.devBypassEnabled) {
      req.principal = authenticator.devPrincipal();
      req.tenantId = req.principal.tenantId;
      return next();
    }

    const token = extractBearer(req);
    if (!token) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="tz-opti"');
      return next(unauthorized('TOKEN_MISSING', 'нет заголовка Authorization: Bearer'));
    }

    try {
      const principal = await authenticator.authenticateToken(token);
      req.principal = principal;
      req.tenantId = principal.tenantId;
      return next();
    } catch (err) {
      const status = err.status || 401;
      if (status === 403) {
        return next(forbidden(err.code || 'PRINCIPAL_REJECTED', err.reason || err.message, 'Субъект не допущен в систему'));
      }
      if (status === 503) {
        const e = new Error('Сервис аутентификации недоступен');
        e.status = 503;
        e.code = err.code || 'AUTH_BACKEND_UNAVAILABLE';
        e.reason = err.reason || err.message;
        return next(e);
      }
      // Причина отказа наружу не раскрывается (в теле — общий текст),
      // но уходит в журнал аудита через err.reason.
      res.setHeader('WWW-Authenticate', 'Bearer realm="tz-opti", error="invalid_token"');
      return next(unauthorized(err.code || 'TOKEN_INVALID', err.reason || err.message));
    }
  };
}

module.exports = { authenticate, extractBearer };
