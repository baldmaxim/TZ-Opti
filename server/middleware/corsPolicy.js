'use strict';

// CORS по СПИСКУ РАЗРЕШЁННЫХ ИСТОЧНИКОВ, без пакета cors и без «*».
//
// Правила:
//   • источник не в списке        → заголовки CORS не выдаются вовсе
//     (браузер сам заблокирует ответ), preflight отвечает 403;
//   • запрос без Origin           → пропускается (curl, серверные вызовы,
//     мобильный клиент): CORS защищает браузерного пользователя, а не сервер;
//   • «*» вместе с credentials    → запрещено спецификацией и здесь тоже;
//   • в production пустой список  → ошибка старта (security/config.js).
//
// decideCors — чистая функция: вся матрица «источник × список» проверяется офлайн.

const ALLOWED_METHODS = 'GET,HEAD,POST,PATCH,PUT,DELETE,OPTIONS';
const ALLOWED_HEADERS = 'Authorization,Content-Type,X-Request-Id,X-Requested-With';
const EXPOSED_HEADERS = 'X-Request-Id,X-Export-Source,Content-Disposition,RateLimit-Limit,RateLimit-Remaining,RateLimit-Reset';

function normalizeOrigin(origin) {
  if (typeof origin !== 'string' || !origin) return '';
  try {
    const u = new URL(origin);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}

function effectiveOrigins(config) {
  if (config.cors.allowedOrigins.length) return config.cors.allowedOrigins.map(normalizeOrigin).filter(Boolean);
  // Вне production пустой список означает «локальная разработка».
  return config.isProduction ? [] : config.cors.devFallbackOrigins;
}

// → { mode: 'no-origin' | 'allowed' | 'denied', origin, headers }
function decideCors(config, { origin, method }) {
  const allowed = effectiveOrigins(config);
  const normalized = normalizeOrigin(origin);
  if (!origin) return { mode: 'no-origin', headers: {} };
  if (!normalized || !allowed.includes(normalized)) return { mode: 'denied', origin: normalized, headers: {} };

  const headers = {
    'Access-Control-Allow-Origin': normalized,
    // Ответ зависит от Origin — без Vary кэш отдаст чужому источнику чужие заголовки.
    Vary: 'Origin',
    'Access-Control-Expose-Headers': EXPOSED_HEADERS,
  };
  if (config.cors.allowCredentials) headers['Access-Control-Allow-Credentials'] = 'true';
  if (String(method).toUpperCase() === 'OPTIONS') {
    headers['Access-Control-Allow-Methods'] = ALLOWED_METHODS;
    headers['Access-Control-Allow-Headers'] = ALLOWED_HEADERS;
    headers['Access-Control-Max-Age'] = String(config.cors.maxAgeSec);
  }
  return { mode: 'allowed', origin: normalized, headers };
}

function corsPolicy(config) {
  return function corsMiddleware(req, res, next) {
    const decision = decideCors(config, { origin: req.headers.origin, method: req.method });
    for (const [k, v] of Object.entries(decision.headers)) res.setHeader(k, v);

    if (req.method === 'OPTIONS') {
      if (decision.mode === 'allowed') return res.status(204).end();
      if (decision.mode === 'denied') return res.status(403).json({ error: 'Источник не разрешён', code: 'CORS_ORIGIN_DENIED' });
    }
    return next();
  };
}

module.exports = { corsPolicy, decideCors, effectiveOrigins, normalizeOrigin, ALLOWED_METHODS, ALLOWED_HEADERS };
