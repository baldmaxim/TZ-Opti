'use strict';

module.exports = function errorHandler(err, _req, res, _next) {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) {
    console.error('[error]', err);
  }
  res.status(status).json({
    error: err.message || 'Internal server error',
    code: err.code || undefined,
    details: err.details || undefined,
  });
};
