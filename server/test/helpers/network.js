'use strict';

// Блокировка исходящей сети в юнит-тестах: любая попытка открыть TCP-соединение
// или сделать fetch падает с понятным сообщением. Так «офлайн» — проверяемое
// свойство теста, а не обещание в комментарии.
//
// Локальные слушатели (app.listen(0) в smoke-тесте) не затрагиваются: мы
// перехватываем только исходящие подключения (net.Socket#connect) и fetch.

const net = require('node:net');

function blockNetwork(t) {
  const realConnect = net.Socket.prototype.connect;
  const realFetch = global.fetch;
  const attempts = [];

  net.Socket.prototype.connect = function blockedConnect(...args) {
    const target = describeTarget(args);
    attempts.push(target);
    throw new Error(`Сеть запрещена в юнит-тесте: попытка подключения к ${target}.`);
  };
  global.fetch = async (input) => {
    const target = String(input && input.url ? input.url : input);
    attempts.push(target);
    throw new Error(`Сеть запрещена в юнит-тесте: попытка fetch ${target}.`);
  };

  const restore = () => {
    net.Socket.prototype.connect = realConnect;
    global.fetch = realFetch;
  };
  if (t && typeof t.after === 'function') t.after(restore);
  return { restore, attempts };
}

// net.Socket#connect принимает (options), (path) или (port[, host]).
function describeTarget(args) {
  const a = args[0];
  if (a && typeof a === 'object') {
    if (a.path) return String(a.path);
    return `${a.host || a.hostname || '?'}:${a.port || '?'}`;
  }
  if (typeof a === 'number' || /^\d+$/.test(String(a))) {
    const host = typeof args[1] === 'string' ? args[1] : 'localhost';
    return `${host}:${a}`;
  }
  return String(a);
}

module.exports = { blockNetwork };
