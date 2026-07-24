'use strict';

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const badRequest = (msg, details) => new HttpError(400, msg, details);
const notFound = (msg = 'Не найдено') => new HttpError(404, msg);
const conflict = (msg, details) => new HttpError(409, msg, details);
const internal = (msg = 'Внутренняя ошибка', details) => new HttpError(500, msg, details);

// Ошибки доступа. Машинный `code` попадает и в ответ, и в журнал аудита —
// по нему видно, ПОЧЕМУ отказано, без разбора текста сообщения.
// В теле ответа никогда не раскрывается, что именно не так с токеном
// (истёк / чужой issuer / плохая подпись) — это подсказка атакующему;
// подробность живёт в `reason` и уходит только в журнал.
function unauthorized(code = 'UNAUTHENTICATED', reason = '') {
  const err = new HttpError(401, 'Требуется аутентификация');
  err.code = code;
  err.reason = reason;
  return err;
}

function forbidden(code = 'FORBIDDEN', reason = '', message = 'Доступ запрещён') {
  const err = new HttpError(403, message);
  err.code = code;
  err.reason = reason;
  return err;
}

const tooManyRequests = (msg = 'Слишком много запросов', details) => {
  const err = new HttpError(429, msg, details);
  err.code = 'RATE_LIMITED';
  return err;
};

module.exports = { HttpError, badRequest, notFound, conflict, internal, unauthorized, forbidden, tooManyRequests };
