'use strict';

const fs = require('fs');
const path = require('path');
const db = require('./connection');

function runMigration() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  db.exec(sql);
  console.log('[migrate] schema applied');
}

if (require.main === module) {
  runMigration();
  process.exit(0);
}

module.exports = { runMigration };
