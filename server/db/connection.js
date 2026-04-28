'use strict';

const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set. See .env.example.');
}

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
  max: 10,
});

pool.on('error', (err) => {
  console.error('[pg pool] idle client error:', err);
});

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
  const client = await pool.connect();
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

async function close() {
  await pool.end();
}

const db = {
  ...makeRunner(pool),
  transaction,
  close,
  pool,
};

module.exports = db;
module.exports._convertPlaceholders = convertPlaceholders;
