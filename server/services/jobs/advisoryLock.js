'use strict';

// Advisory-lock области анализа: последний рубеж против одновременного прогона
// одной стадии одной ревизии ТЗ. Очередь и так не даёт двух живых заданий на
// область, но замок работает НА УРОВНЕ БД и поэтому держит даже то, что очередь
// не видит: два процесса-воркера, «зависший» старый процесс, ручной запуск.
//
// Почему session-level, а не xact-level: задача считается минутами, держать всё
// это время открытую транзакцию нельзя. Замок берётся на ВЫДЕЛЕННОМ соединении
// (db.acquireSession) и снимается в finally; если процесс умер — сессия рвётся,
// и Postgres освобождает замок сам. Это и есть страховка от вечного залипания.
//
// Ключ — детерминированный bigint от (тендер + область + ревизия документов),
// см. jobModel.advisoryLockKey. Передаём строкой и приводим ::bigint, чтобы не
// потерять точность в JS number.

const db = require('../../db/connection');

// Пытается взять замок. Успех → handle с release(); занято → null (задача
// вернётся в очередь и попробует позже — воркер не блокируется).
async function acquire(lockKey, { label = null } = {}) {
  const session = await db.acquireSession();
  let ok = false;
  try {
    const row = await session.queryOne('SELECT pg_try_advisory_lock(?::bigint) AS locked', String(lockKey));
    ok = Boolean(row && row.locked);
  } catch (e) {
    session.release(true);
    throw e;
  }
  if (!ok) {
    session.release();
    return null;
  }
  let released = false;
  return {
    key: String(lockKey),
    label,
    async release() {
      if (released) return;
      released = true;
      try {
        await session.queryOne('SELECT pg_advisory_unlock(?::bigint) AS released', String(lockKey));
        session.release();
      } catch (_e) {
        // Не смогли снять замок — соединение уничтожаем: обрыв сессии
        // освобождает замок гарантированно, возвращать её в пул нельзя.
        session.release(true);
      }
    },
  };
}

// Диагностика: держит ли кто-то этот замок (по pg_locks текущей БД).
// В pg_locks ключ разложен на classid/objid (старшие/младшие 32 бита) как
// БЕЗЗНАКОВЫЙ — собираем его обратно в numeric, чтобы не упереться в bigint.
async function isHeld(lockKey) {
  const row = await db.queryOne(
    `SELECT COUNT(*) AS c FROM pg_locks
      WHERE locktype = 'advisory' AND granted
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND (classid::bigint::numeric * 4294967296 + objid::bigint::numeric) = ?::numeric`,
    BigInt.asUintN(64, BigInt(String(lockKey))).toString(),
  );
  return Number(row && row.c) > 0;
}

module.exports = { acquire, isHeld };
