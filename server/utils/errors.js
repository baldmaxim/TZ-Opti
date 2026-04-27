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

module.exports = { HttpError, badRequest, notFound, conflict, internal };
