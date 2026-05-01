'use strict';

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const db = require('./connection');

async function columnExists(table, column) {
  const r = await db.queryOne(
    `SELECT 1 AS ok
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ? AND column_name = ?`,
    table,
    column,
  );
  return Boolean(r);
}

async function ensureColumn(table, column, type) {
  if (await columnExists(table, column)) return false;
  await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type};`);
  console.log(`[migrate] ${table}.${column} added`);
  return true;
}

async function runMigration() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await db.exec(sql);

  // Идемпотентные ALTER-ы для расширения существующих таблиц.
  await ensureColumn('company_conditions', 'condition_idx', 'INTEGER');
  await ensureColumn('company_conditions', 'text_override', 'TEXT');
  await ensureColumn('qa_entries', 'section', 'TEXT');
  await ensureColumn('qa_entries', 'sent_at', 'TEXT');
  await ensureColumn('qa_entries', 'answer_at', 'TEXT');
  await ensureColumn('qa_entries', 'round_label', 'TEXT');
  await ensureColumn('qa_entries', 'tz_clause', 'TEXT');
  await ensureColumn('qa_entries', 'tz_reflected', 'INTEGER DEFAULT 0');
  await ensureColumn('qa_entries', 'tz_contradicts', 'INTEGER DEFAULT 0');
  await ensureColumn('qa_entries', 'affects_calc', 'INTEGER DEFAULT 0');
  await ensureColumn('qa_entries', 'affects_kp', 'INTEGER DEFAULT 0');
  await ensureColumn('qa_entries', 'affects_contract', 'INTEGER DEFAULT 0');
  await ensureColumn('qa_entries', 'affects_schedule', 'INTEGER DEFAULT 0');

  // Стадия 5 (Самоанализ ТЗ) — добавлена при введении новой Стадии 3
  // (Существенные условия). Старые данные нужно сдвинуть: 4→5, 3→4,
  // 3 = locked (новая пустая стадия).
  const stage5Added = await ensureColumn('tender_stage_state', 'stage5_status', "TEXT DEFAULT 'locked'");
  if (stage5Added) {
    // Сдвигаем статусы стадий: текущий stage4 (selfAnalysis) → stage5,
    // текущий stage3 (risks) → stage4, новый stage3 (conditions) = locked.
    await db.exec(`
      UPDATE tender_stage_state
         SET stage5_status = stage4_status,
             stage4_status = stage3_status,
             stage3_status = 'locked';
    `);
    // Сдвигаем номера стадий в issues: 4→5, 3→4 (порядок важен — сначала 4→5 чтобы не наложились).
    await db.exec(`UPDATE issues SET analysis_stage = 5 WHERE analysis_stage = 4;`);
    await db.exec(`UPDATE issues SET analysis_stage = 4 WHERE analysis_stage = 3;`);
    // Аналогично в analysis_runs.
    await db.exec(`UPDATE analysis_runs SET stage = 5 WHERE stage = 4;`);
    await db.exec(`UPDATE analysis_runs SET stage = 4 WHERE stage = 3;`);
    // И в tz_excluded_ranges (after_stage).
    await db.exec(`UPDATE tz_excluded_ranges SET after_stage = 5 WHERE after_stage = 4;`);
    await db.exec(`UPDATE tz_excluded_ranges SET after_stage = 4 WHERE after_stage = 3;`);
    console.log('[migrate] stages renumbered: 3=conditions(new), 4=risks(was 3), 5=selfAnalysis(was 4)');
  }

  // Порядок ручного ввода характеристик (для отображения в UI).
  const added = await ensureColumn('characteristics', 'sort_order', 'INTEGER DEFAULT 0');
  if (added) {
    // Заполняем sort_order для уже существующих строк по физическому
    // порядку вставки (ctid), отдельно по каждому тендеру.
    await db.exec(`
      UPDATE characteristics AS c
         SET sort_order = sub.rn
        FROM (
          SELECT id,
                 ROW_NUMBER() OVER (PARTITION BY tender_id ORDER BY ctid) AS rn
            FROM characteristics
        ) AS sub
       WHERE c.id = sub.id;
    `);
    console.log('[migrate] characteristics.sort_order backfilled');
  }

  console.log('[migrate] schema applied');
}

if (require.main === module) {
  runMigration()
    .then(() => db.close())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[migrate] failed:', err);
      process.exit(1);
    });
}

module.exports = { runMigration };
