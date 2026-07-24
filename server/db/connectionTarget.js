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

// Параметр ssl для pg.Pool.
//
// В PRODUCTION проверка сертификата СТРОГАЯ и отключить её нечем:
//   • rejectUnauthorized: true всегда;
//   • sslmode=disable / sslmode=no-verify в строке подключения — ошибка, а не
//     «ну ладно, поедем без TLS» (иначе одна строка в .env тихо снимает
//     шифрование канала с ТЗ и коммерческими условиями);
//   • корневой сертификат берётся из PGSSLROOTCERT / DATABASE_CA_CERT_FILE
//     (путь) либо DATABASE_CA_CERT (PEM в переменной) — нужен для managed
//     Postgres со своим CA; без него используется системный набор.
// Вне production поведение прежнее: TLS включён, но сертификат не проверяется
// (self-signed у локального кластера), а sslmode=disable отключает TLS.
//
// Хост из строки подключения передаётся в servername — при подключении через
// пул-прокси (Supabase pooler) имя в сертификате обязано совпадать с хостом.

const fs = require('fs');

function readCaCert(env) {
  const inline = (env.DATABASE_CA_CERT || '').trim();
  if (inline) return inline.includes('-----BEGIN') ? inline : Buffer.from(inline, 'base64').toString('utf8');
  const file = ((env.PGSSLROOTCERT || env.DATABASE_CA_CERT_FILE) || '').trim();
  if (!file) return null;
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new DbTargetError('DB_CA_CERT_UNREADABLE', `Корневой сертификат Postgres не прочитан: ${err.code || err.message}`);
  }
}

function hostFrom(connectionString) {
  try {
    return new URL(connectionString).hostname || undefined;
  } catch {
    return undefined;
  }
}

function sslOptionFor(connectionString, env = process.env) {
  const url = connectionString || '';
  const disabled = /[?&]sslmode=disable(\b|&|$)/i.test(url);
  const noVerify = /[?&]sslmode=no-verify(\b|&|$)/i.test(url);
  const { resolveMode } = require('../security/config');
  const isProduction = resolveMode(env) === 'production';

  if (!isProduction) {
    if (disabled) return false;
    return { rejectUnauthorized: false };
  }

  if (disabled) {
    throw new DbTargetError(
      'DB_TLS_DISABLED_IN_PRODUCTION',
      'sslmode=disable запрещён в production: соединение с Postgres обязано быть зашифровано.',
    );
  }
  if (noVerify) {
    throw new DbTargetError(
      'DB_TLS_VERIFY_DISABLED_IN_PRODUCTION',
      'sslmode=no-verify запрещён в production: сертификат Postgres обязан проверяться.',
    );
  }
  const ca = readCaCert(env);
  const options = { rejectUnauthorized: true, servername: hostFrom(url) };
  if (ca) options.ca = ca;
  return options;
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
