'use strict';

// Единый обработчик ошибок.
//
// Правило production: наружу уходит только то, что клиенту НУЖНО, чтобы
// исправить свой запрос. Доменные ошибки (4xx) сохраняют текст — «Не загружен
// ТЗ» инженеру полезно. Внутренние сбои (5xx) схлопываются в одну фразу и
// request_id: сообщение драйвера БД, путь на диске, имя переменной окружения
// или строка подключения наружу не выходят никогда. В логе остаётся всё.
//
// Вне production (ERRORS_EXPOSE_INTERNALS=1 по умолчанию) поведение прежнее —
// разработчик видит настоящую ошибку в ответе.

const { getSecurityConfig } = require('../security/config');

const GENERIC_500 = 'Внутренняя ошибка сервера';

function errorHandler(err, req, res, _next) {
  const status = err.status || err.statusCode || 500;
  const config = getSecurityConfig();
  const requestId = req && req.requestId;

  // Причина отказа/сбоя — для журнала аудита (middleware/auditLogger.js).
  if (req) {
    req.errorInfo = { status, code: err.code || null, reason: err.reason || err.message || null };
  }

  if (status >= 500) {
    console.error(`[error]${requestId ? ` [${requestId}]` : ''}`, err);
  } else if (status === 401 || status === 403) {
    // Отказы доступа полезно видеть в логе с причиной — но без токена.
    console.warn(`[access]${requestId ? ` [${requestId}]` : ''} ${status} ${err.code || ''} ${err.reason || ''}`.trimEnd());
  }

  const expose = config.errors.exposeInternals;
  const body = { error: status >= 500 && !expose ? GENERIC_500 : err.message || GENERIC_500 };

  if (err.code) body.code = err.code;
  // details — часть контракта доменных ошибок (409 STAGE_LOCKED и т.п.);
  // у 5xx они наружу не идут, там детали всегда внутренние.
  if (err.details !== undefined && (status < 500 || expose)) body.details = err.details;
  if (requestId) body.request_id = requestId;
  if (expose && status >= 500 && err.stack) body.stack = String(err.stack).split('\n').slice(0, 5);

  res.status(status).json(body);
}

module.exports = errorHandler;
module.exports.GENERIC_500 = GENERIC_500;
