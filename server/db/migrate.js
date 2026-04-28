'use strict';

const fs = require('fs');
const path = require('path');
const db = require('./connection');

function columnExists(table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === column);
}

function ensureColumn(table, column, type) {
  if (columnExists(table, column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type};`);
  console.log(`[migrate] ${table}.${column} added`);
  return true;
}

function runMigration() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  db.exec(sql);

  // Идемпотентные ALTER-ы для расширения существующих таблиц.
  ensureColumn('company_conditions', 'condition_idx', 'INTEGER');
  ensureColumn('company_conditions', 'text_override', 'TEXT');

  console.log('[migrate] schema applied');
}

if (require.main === module) {
  runMigration();
  process.exit(0);
}

module.exports = { runMigration };
