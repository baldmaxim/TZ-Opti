'use strict';

const { Pool } = require('pg');
const { resolveConnectionString, sslOptionFor } = require('./connectionTarget');

// Пул создаётся ЛЕНИВО — на первом реальном обращении к БД, а не на импорте
// модуля. Это позволяет юнит-тестам и smoke-тестам подключать сервисы и
// createApp() без Postgres и без сети. Fail-closed сохраняется: любой запрос
// без корректной цели подключения бросает (см. connectionTarget.js).
let pool = null;

function getPool() {
  if (pool) return pool;
  const connectionString = resolveConnectionString(process.env);
  pool = new Pool({
    connectionString,
    ssl: sslOptionFor(connectionString),
    max: 10,
  });
  pool.on('error', (err) => {
    console.error('[pg pool] idle client error:', err);
  });
  return pool;
}

// Ленивый executor: подставляется в makeRunner вместо готового пула.
const lazyExecutor = {
  query: (text, params) => getPool().query(text, params),
};

// Конвертирует sqlite-style плейсхолдеры (?) в postgres-style ($1, $2, ...).
// Учитывает строковые литералы '...' (со escape ''), идентификаторы "...",
// однострочные комментарии -- и блочные /* ... */.
function convertPlaceholders(sql) {
  let out = '';
  let n = 0;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") {
      out += ch;
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          out += "''";
          i += 2;
        } else if (sql[i] === "'") {
          out += "'";
          i++;
          break;
        } else {
          out += sql[i];
          i++;
        }
      }
      continue;
    }
    if (ch === '"') {
      out += ch;
      i++;
      while (i < sql.length && sql[i] !== '"') {
        out += sql[i];
        i++;
      }
      if (i < sql.length) {
        out += '"';
        i++;
      }
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') {
        out += sql[i];
        i++;
      }
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      out += '/*';
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) {
        out += sql[i];
        i++;
      }
      if (i < sql.length) {
        out += '*/';
        i += 2;
      }
      continue;
    }
    if (ch === '?') {
      n++;
      out += '$' + n;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function makeRunner(executor) {
  return {
    async queryOne(sql, ...params) {
      const r = await executor.query(convertPlaceholders(sql), params);
      return r.rows[0];
    },
    async queryAll(sql, ...params) {
      const r = await executor.query(convertPlaceholders(sql), params);
      return r.rows;
    },
    async queryRun(sql, ...params) {
      const r = await executor.query(convertPlaceholders(sql), params);
      return { changes: r.rowCount, rows: r.rows };
    },
    async exec(sql) {
      await executor.query(sql);
    },
  };
}

async function transaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const tx = makeRunner(client);
    const result = await fn(tx);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('[pg transaction] rollback failed:', rollbackErr);
    }
    throw err;
  } finally {
    client.release();
  }
}

// Закрывает пул, если он вообще был создан (иначе — no-op, чтобы код
// завершения не поднимал соединение только ради его закрытия).
async function close() {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end();
}

const db = {
  ...makeRunner(lazyExecutor),
  transaction,
  close,
};

// db.pool сохранён для обратной совместимости, но теперь это геттер:
// обращение к нему поднимает пул, простой импорт модуля — нет.
Object.defineProperty(db, 'pool', { get: getPool, enumerable: false });

module.exports = db;
module.exports._convertPlaceholders = convertPlaceholders;
module.exports.isPoolOpen = () => pool !== null;
