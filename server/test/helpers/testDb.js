'use strict';

// Доступ к БД для integration-тестов.
//
// Инвариант: тест НИКОГДА не подключается к production-БД. Цель подключения
// резолвит db/connectionTarget.js, и в тестовом процессе он читает только
// TEST_DATABASE_URL (совпадение с DATABASE_URL — ошибка). Здесь — лишь
// решение «пропустить или упасть», когда тестовой БД нет:
//   • по умолчанию         → тест помечается skip с явной причиной;
//   • при TEST_DB_REQUIRED=1 (npm run verify:integration) → падает.

const { resolveConnectionString, hasResolvableTarget } = require('../../db/connectionTarget');

const REQUIRED = () => (process.env.TEST_DB_REQUIRED || '').trim() === '1';

function skipReason() {
  if (hasResolvableTarget()) return null;
  try {
    resolveConnectionString();
    return null;
  } catch (err) {
    return err.message;
  }
}

// Опции для node:test: { skip: '<причина>' } либо {}.
// В строгом режиме (TEST_DB_REQUIRED=1) вместо skip — бросаем на месте.
function dbTestOptions() {
  const reason = skipReason();
  if (!reason) return {};
  if (REQUIRED()) {
    throw new Error(`TEST_DB_REQUIRED=1, но тестовая БД недоступна: ${reason}`);
  }
  return { skip: `нет тестовой БД: ${reason}` };
}

// Ленивое подключение: db создаёт пул на первом запросе (см. db/connection.js).
function getDb() {
  resolveConnectionString(); // fail-closed до первого запроса
  // eslint-disable-next-line global-require
  return require('../../db/connection');
}

async function closeDb() {
  const db = require('../../db/connection');
  if (db.isPoolOpen && db.isPoolOpen()) await db.close();
}

module.exports = { dbTestOptions, skipReason, getDb, closeDb, isStrict: REQUIRED };
