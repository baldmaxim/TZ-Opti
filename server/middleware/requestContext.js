'use strict';

// Идентификатор запроса: сквозная нить между логом, журналом аудита и ответом
// клиенту. По нему инженер поддержки связывает «у меня ошибка 500 вот с таким
// номером» с конкретной строкой лога — не выдавая наружу ничего внутреннего.
//
// Входящий X-Request-Id принимается (трассировка сквозь прокси/шлюз), но
// только если он похож на идентификатор: произвольная строка из заголовка
// попала бы в логи и в БД как есть (log injection).

const crypto = require('crypto');

const SAFE_ID = /^[A-Za-z0-9._:-]{8,128}$/;

function clientIp(req, trustProxyHops = 0) {
  if (trustProxyHops > 0) {
    const chain = String(req.headers['x-forwarded-for'] || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    // Доверяем ровно N последним звеньям цепочки: адрес клиента — тот, что
    // стоит перед ними. Слепо брать первый элемент нельзя — его пишет клиент.
    if (chain.length) {
      const idx = Math.max(0, chain.length - trustProxyHops);
      if (chain[idx]) return chain[idx];
      return chain[chain.length - 1];
    }
  }
  return (req.socket && req.socket.remoteAddress) || null;
}

function requestContext({ trustProxyHops = 0 } = {}) {
  return function requestContextMiddleware(req, res, next) {
    const incoming = req.headers['x-request-id'];
    const id = typeof incoming === 'string' && SAFE_ID.test(incoming) ? incoming : crypto.randomUUID();
    req.requestId = id;
    req.clientIp = clientIp(req, trustProxyHops);
    req.startedAt = Date.now();
    res.setHeader('X-Request-Id', id);
    next();
  };
}

module.exports = { requestContext, clientIp, SAFE_ID };
