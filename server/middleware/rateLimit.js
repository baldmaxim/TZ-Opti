'use strict';

// Ограничение частоты запросов. Реализация — фиксированное окно в памяти
// процесса, без внешних зависимостей и без Redis.
//
// Ограничение честно названо: счётчики ЛОКАЛЬНЫ для процесса. При нескольких
// инстансах фактический лимит умножается на их число — это приемлемо для
// защиты от «одного цикла в скрипте» и от подбора токенов, но не заменяет
// лимитер на входном прокси. Общий стор (Postgres/Redis) — следующий шаг,
// точка расширения одна: createStore().
//
// Три уровня:
//   1. по IP  — общий поток запросов и отдельный счётчик НЕУДАЧНЫХ
//      аутентификаций (защита от подбора токена, живёт до истечения окна);
//   2. по субъекту — дорогие действия: загрузка, запуск анализа, выгрузка;
//   3. точечные лимиты берутся из security/policy.js по категории действия.

const { tooManyRequests } = require('../utils/errors');
const { resolvePolicy, isPublicPath } = require('../security/policy');

// Хранилище счётчиков: Map<key, {count, resetAt}> с ленивой уборкой.
function createStore({ maxKeys = 50000 } = {}) {
  const buckets = new Map();
  let checks = 0;

  function sweep(now) {
    for (const [key, entry] of buckets) {
      if (entry.resetAt <= now) buckets.delete(key);
    }
  }

  return {
    hit(key, windowMs, limit, now = Date.now()) {
      if (++checks % 1000 === 0) sweep(now);
      let entry = buckets.get(key);
      if (!entry || entry.resetAt <= now) {
        entry = { count: 0, resetAt: now + windowMs };
        // Переполнение таблицы (распределённый источник запросов) — чистим
        // протухшее; если не помогло, новые ключи не заводим, а считаем
        // запрос разрешённым: лимитер не должен превращаться в отказ сервиса.
        if (buckets.size >= maxKeys) {
          sweep(now);
          if (buckets.size >= maxKeys) return { allowed: true, limit, remaining: limit, resetAt: now + windowMs, overflow: true };
        }
        buckets.set(key, entry);
      }
      entry.count += 1;
      const remaining = Math.max(0, limit - entry.count);
      return { allowed: entry.count <= limit, limit, remaining, resetAt: entry.resetAt, count: entry.count };
    },
    peek(key, now = Date.now()) {
      const entry = buckets.get(key);
      if (!entry || entry.resetAt <= now) return null;
      return { ...entry };
    },
    reset() {
      buckets.clear();
    },
    size: () => buckets.size,
  };
}

function setHeaders(res, result) {
  res.setHeader('RateLimit-Limit', String(result.limit));
  res.setHeader('RateLimit-Remaining', String(result.remaining));
  res.setHeader('RateLimit-Reset', String(Math.max(0, Math.ceil((result.resetAt - Date.now()) / 1000))));
}

function deny(res, result) {
  const retryAfter = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
  res.setHeader('Retry-After', String(retryAfter));
  return tooManyRequests('Слишком много запросов, повторите позже', { retry_after_sec: retryAfter });
}

// Лимиты по категории действия (security/policy.js).
function limitForCategory(config, category) {
  const rl = config.rateLimit;
  if (category === 'analysis') return rl.analysisMax;
  if (category === 'export') return rl.exportMax;
  return null;
}

function createRateLimit(config, { store = createStore(), authFailStore = createStore() } = {}) {
  const windowMs = Math.max(1, config.rateLimit.windowSec) * 1000;

  // Уровень 1: по IP, ДО аутентификации.
  function byIp(req, res, next) {
    if (!config.rateLimit.enabled || isPublicPath(req.path) || req.method === 'OPTIONS') return next();
    const ip = req.clientIp || 'unknown';

    // Подбор токена: после N неудач с одного адреса — отказ до конца окна.
    const failed = authFailStore.peek(`fail:${ip}`);
    if (failed && failed.count > config.rateLimit.authFailMax) {
      return next(deny(res, { limit: config.rateLimit.authFailMax, remaining: 0, resetAt: failed.resetAt }));
    }

    const result = store.hit(`ip:${ip}`, windowMs, config.rateLimit.max);
    setHeaders(res, result);
    if (!result.allowed) return next(deny(res, result));

    // Неудачную аутентификацию видно только по статусу ответа.
    res.on('finish', () => {
      if (res.statusCode === 401) authFailStore.hit(`fail:${ip}`, windowMs, config.rateLimit.authFailMax);
    });
    return next();
  }

  // Уровень 2: дорогие действия, ПОСЛЕ аутентификации (ключ — субъект).
  function byAction(req, res, next) {
    if (!config.rateLimit.enabled || isPublicPath(req.path) || req.method === 'OPTIONS') return next();
    const policy = (req.security && req.security.policy) || resolvePolicy(req.method, req.path);
    if (!policy) return next();

    const subject = (req.principal && req.principal.subject) || req.clientIp || 'unknown';
    const isUpload = policy.action === 'document.upload' || policy.action === 'qa.import';
    const limit = isUpload ? config.rateLimit.uploadMax : limitForCategory(config, policy.category);
    if (!limit) return next();

    const bucket = isUpload ? 'upload' : policy.category;
    const result = store.hit(`sub:${subject}:${bucket}`, windowMs, limit);
    setHeaders(res, result);
    if (!result.allowed) return next(deny(res, result));
    return next();
  }

  return { byIp, byAction, store, authFailStore };
}

module.exports = { createRateLimit, createStore };
