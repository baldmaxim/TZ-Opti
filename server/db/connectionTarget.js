'use strict';

// Выбор целевой БД — чистая функция, отдельно от pg-пула (тестируется офлайн).
//
// Инвариант: тестовый процесс НИКОГДА не подключается к production-БД.
//   • обычный процесс  → DATABASE_URL (обязателен);
//   • тестовый процесс → TEST_DATABASE_URL (обязателен), DATABASE_URL вообще
//     не используется как источник подключения; совпадение TEST_DATABASE_URL
//     с DATABASE_URL — ошибка, а не «ну и ладно».
// Любая неоднозначность — fail-closed: бросаем, а не молча берём что-нибудь.

const { isTestProcess } = require('../utils/runtimeMode');

class DbTargetError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DbTargetError';
    this.code = code;
  }
}

const trim = (v) => (typeof v === 'string' ? v.trim() : '');

// Возвращает строку подключения либо бросает DbTargetError с машинным code.
// Значения строк подключения (в них пароль) никогда не попадают в текст ошибки.
function resolveConnectionString(env = process.env) {
  if (isTestProcess(env)) {
    const testUrl = trim(env.TEST_DATABASE_URL);
    if (!testUrl) {
      throw new DbTargetError(
        'TEST_DATABASE_URL_MISSING',
        'Тестовый процесс: TEST_DATABASE_URL не задан. Production DATABASE_URL в тестах не используется. См. docs/development.md.',
      );
    }
    if (testUrl === trim(env.DATABASE_URL)) {
      throw new DbTargetError(
        'TEST_DATABASE_URL_EQUALS_PRODUCTION',
        'Тестовый процесс: TEST_DATABASE_URL совпадает с DATABASE_URL. Заведите отдельную тестовую БД.',
      );
    }
    return testUrl;
  }

  const url = trim(env.DATABASE_URL);
  if (!url) {
    throw new DbTargetError('DATABASE_URL_MISSING', 'DATABASE_URL is not set. See .env.example.');
  }
  return url;
}

// Параметр ssl для pg.Pool. По умолчанию TLS включён (Supabase/managed
// Postgres), единственное исключение — явный `sslmode=disable` в строке
// подключения (локальный кластер для integration-тестов). Правило явное:
// молча «попробовать без TLS» при ошибке нельзя.
function sslOptionFor(connectionString) {
  if (/[?&]sslmode=disable(\b|&|$)/i.test(connectionString || '')) return false;
  return { rejectUnauthorized: false };
}

// Есть ли вообще доступная цель — для integration-тестов (skip vs strict).
function hasResolvableTarget(env = process.env) {
  try {
    resolveConnectionString(env);
    return true;
  } catch {
    return false;
  }
}

module.exports = { resolveConnectionString, hasResolvableTarget, sslOptionFor, DbTargetError };
