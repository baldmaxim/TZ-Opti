'use strict';

/**
 * Одноразовая миграция: чинит «мохидзаке» в documents.name, оставшееся
 * от загрузок до фикса в middleware/upload.js.
 *
 * Идемпотентна: уже корректные UTF-8 имена не трогает (определяет по
 * наличию символов с кодом > 0xFF — у мангленных строк все символы
 * лежат в [0x00..0xFF]).
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const db = require('./connection');
const { decodeMulterFilename } = require('../utils/filename');

function isMangled(s) {
  if (!s) return false;
  let hasHigh = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0xFF) return false;        // настоящий Unicode — не трогаем
    if (c > 0x7F) hasHigh = true;      // есть high-byte — потенциально мангленная
  }
  return hasHigh;
}

function run() {
  const rows = db.prepare('SELECT id, name FROM documents').all();
  let fixed = 0;
  const upd = db.prepare('UPDATE documents SET name = ? WHERE id = ?');
  const tx = db.transaction((items) => {
    for (const r of items) {
      if (!isMangled(r.name)) continue;
      const next = decodeMulterFilename(r.name);
      if (next && next !== r.name) {
        upd.run(next, r.id);
        fixed++;
        console.log(`  ✓ ${r.id}: «${r.name}» → «${next}»`);
      }
    }
  });
  tx(rows);
  console.log(`[fix-filenames] исправлено: ${fixed} из ${rows.length}`);
}

if (require.main === module) {
  run();
  process.exit(0);
}

module.exports = { run };
