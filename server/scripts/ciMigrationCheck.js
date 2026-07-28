#!/usr/bin/env node
'use strict';

// Проверка МИГРАЦИИ для CI — два разных риска, две разные команды.
//
//   node scripts/ciMigrationCheck.js --empty
//     ПУСТАЯ БД: схема разворачивается с нуля (новая установка, новый стенд).
//     Проверяем, что после runMigration существуют все таблицы схемы и ключевые
//     инварианты (тенант по умолчанию, NOT NULL на tenders.tenant_id), а
//     повторный прогон миграции ничего не ломает — она обязана быть идемпотентной.
//
//   node scripts/ciMigrationCheck.js --populated
//     НАСЕЛЁННАЯ БД: миграция накатывается на базу С ДАННЫМИ. Это отдельный
//     риск: идемпотентный DDL может быть безопасным, а backfill снимков анализа
//     (issues.analysis_run_id, указатели analysis_active_runs) — нет. Проверяем,
//     что после повторной миграции населённой базы НИ ОДНА строка не потеряна и
//     не размножена, а backfill довёл данные до инвариантов снимка.
//
// Подключение — DATABASE_URL (процесс НЕ тестовый). В CI это отдельная база,
// заводимая под задачу; на рабочую базу это запускать нельзя — скрипт сеет
// демо-данные (--populated).

const path = require('path');

const db = require('../db/connection');
const { runMigration } = require('../db/migrate');

// Полный список таблиц схемы: если миграция «прошла», но таблицы нет —
// значит, применилась не та схема.
const REQUIRED_TABLES = [
  'tenders', 'documents', 'work_checklist_items', 'vor_items', 'company_conditions',
  'risk_templates', 'qa_entries', 'characteristics', 'analysis_runs', 'analysis_active_runs',
  'issues', 'analysis_signals', 'draft_issues', 'issue_reviews', 'issue_clusters',
  'issue_cluster_items', 'self_analysis_results', 'review_decisions', 'tz_excluded_ranges',
  'tender_custom_risks', 'tender_risk_state', 'tender_setup_params', 'setup_locks',
  'tender_stage_state', 'analysis_jobs', 'analysis_tasks', 'analysis_segments',
  'analysis_run_segments', 'tenants', 'audit_log',
];

// Таблицы ДАННЫХ: миграция населённой БД не имеет права изменить в них ни одной
// строки — ни потерять, ни размножить. (analysis_runs / analysis_active_runs сюда
// НЕ входят: backfill законно достраивает синтетические прогоны и указатели.)
const COUNTED_TABLES = [
  'tenders', 'documents', 'work_checklist_items', 'vor_items', 'company_conditions',
  'qa_entries', 'characteristics', 'issues', 'analysis_signals', 'draft_issues',
  'review_decisions', 'tenants',
];

const fail = (message) => {
  console.error(`[migration-check] ПРОВАЛ: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
};

const ok = (message) => console.log(`[migration-check] ok — ${message}`);

async function listTables() {
  const rows = await db.queryAll(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
  );
  return new Set(rows.map((r) => r.table_name));
}

async function counts() {
  const out = {};
  for (const table of COUNTED_TABLES) {
    // eslint-disable-next-line no-await-in-loop
    const row = await db.queryOne(`SELECT COUNT(*) AS c FROM ${table}`);
    out[table] = Number(row.c);
  }
  return out;
}

async function assertSchema() {
  const tables = await listTables();
  const missing = REQUIRED_TABLES.filter((t) => !tables.has(t));
  if (missing.length) fail(`после миграции нет таблиц: ${missing.join(', ')}`);
  ok(`схема на месте (${REQUIRED_TABLES.length} таблиц)`);
}

// Инварианты, которые обязана обеспечить именно миграция, а не приложение.
async function assertInvariants() {
  const column = await db.queryOne(
    `SELECT is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'tenders' AND column_name = 'tenant_id'`,
  );
  if (!column) fail('нет колонки tenders.tenant_id');
  if (column.is_nullable !== 'NO') fail('tenders.tenant_id обязан быть NOT NULL (изоляция тенантов)');
  if (!column.column_default) fail('у tenders.tenant_id обязан быть DEFAULT — вставка в обход контроллера не должна давать «ничей» тендер');

  const defaultTenant = (process.env.SECURITY_DEFAULT_TENANT || 'default').trim();
  const tenant = await db.queryOne('SELECT id FROM tenants WHERE id = ?', defaultTenant);
  if (!tenant) fail(`миграция не завела тенант по умолчанию «${defaultTenant}»`);

  const orphanTenders = await db.queryOne(
    `SELECT COUNT(*) AS c FROM tenders t LEFT JOIN tenants n ON n.id = t.tenant_id WHERE n.id IS NULL`,
  );
  if (Number(orphanTenders.c)) fail(`${orphanTenders.c} тендеров ссылаются на несуществующий тенант`);
  ok('инварианты изоляции тенантов выполнены');
}

// Инварианты снимка анализа: после backfill каждая находка обязана принадлежать
// прогону, иначе run-скоуп чтений (issuesRunFilter) молча покажет ноль.
async function assertSnapshotBackfill() {
  const orphanIssues = await db.queryOne(
    'SELECT COUNT(*) AS c FROM issues WHERE analysis_run_id IS NULL AND analysis_stage IS NOT NULL',
  );
  if (Number(orphanIssues.c)) fail(`${orphanIssues.c} находок без analysis_run_id — backfill снимков не отработал`);

  const orphanSignals = await db.queryOne(
    'SELECT COUNT(*) AS c FROM analysis_signals WHERE analysis_run_id IS NULL',
  );
  if (Number(orphanSignals.c)) fail(`${orphanSignals.c} сигналов без analysis_run_id`);
  ok('backfill снимков анализа: строк без прогона не осталось');
}

async function checkEmpty() {
  const before = await listTables();
  if (before.has('tenders')) {
    console.warn('[migration-check] ВНИМАНИЕ: база не пуста (таблица tenders уже есть) — проверка «с нуля» ослаблена');
  }

  await runMigration();
  await assertSchema();
  await assertInvariants();

  // Идемпотентность: повторная миграция на только что развёрнутой схеме.
  await runMigration();
  await assertSchema();
  ok('повторная миграция пустой БД прошла без ошибок (идемпотентность)');

  const tenders = await db.queryOne('SELECT COUNT(*) AS c FROM tenders');
  if (Number(tenders.c)) fail(`миграция пустой БД не должна создавать тендеры (найдено ${tenders.c})`);
  ok('миграция данных не выдумывает: тендеров 0');
}

// LEGACY-строки: результат анализа из версии, где снимков (analysis_run_id) ещё
// не было. Именно их обязан подобрать backfill — без них «населённая БД»
// проверяет только DDL, а самая опасная часть миграции не выполняется вовсе.
async function insertLegacyAnalysis(tenderId) {
  const now = new Date().toISOString();
  await db.queryRun(
    `INSERT INTO issues (id, tender_id, analysis_run_id, analysis_stage, source_fragment,
                         problem_type, criticality, review_status)
     VALUES ('ci-legacy-issue', ?, NULL, 1, 'Фрагмент ТЗ из старой версии портала',
             'не_учтено_в_вор', 'high', 'pending')`,
    tenderId,
  );
  await db.queryRun(
    `INSERT INTO analysis_signals (id, tender_id, analysis_run_id, analysis_stage, signal_type,
                                   source_entity_type, source_entity_id, source_fragment, created_at)
     VALUES ('ci-legacy-signal', ?, NULL, 1, 'coverage', 'issue', 'ci-legacy-issue',
             'Фрагмент ТЗ из старой версии портала', ?)`,
    tenderId, now,
  );
  await db.queryRun(
    `INSERT INTO draft_issues (id, tender_id, analysis_run_id, source_fragment, problem_type, created_at)
     VALUES ('ci-legacy-draft', ?, NULL, 'Фрагмент ТЗ из старой версии портала', 'не_учтено_в_вор', ?)`,
    tenderId, now,
  );
}

async function checkPopulated() {
  await runMigration();
  await assertSchema();

  // Населяем базу демо-данными (тендеры, документы, чек-листы, ВОР-позиции).
  const { runSeed } = require('../db/seed');
  await runSeed(true);

  const tender = await db.queryOne('SELECT id FROM tenders ORDER BY id LIMIT 1');
  if (!tender) fail('сид не создал ни одного тендера — «населённую БД» проверять не на чем');
  await insertLegacyAnalysis(tender.id);

  const before = await counts();
  const idsBefore = (await db.queryAll('SELECT id FROM tenders ORDER BY id')).map((r) => r.id);
  ok(`база населена: ${Object.entries(before).map(([t, c]) => `${t}=${c}`).join(' ')}`);

  // ГЛАВНОЕ: миграция накатывается на базу С ДАННЫМИ.
  await runMigration();
  await assertSchema();
  await assertInvariants();
  await assertSnapshotBackfill();

  const after = await counts();
  for (const table of COUNTED_TABLES) {
    if (after[table] !== before[table]) {
      fail(`миграция населённой БД изменила ${table}: было ${before[table]}, стало ${after[table]}`);
    }
  }
  const idsAfter = (await db.queryAll('SELECT id FROM tenders ORDER BY id')).map((r) => r.id);
  if (idsAfter.join(',') !== idsBefore.join(',')) fail('миграция населённой БД изменила состав тендеров');
  ok('данные пережили миграцию без потерь и дублей');

  // Backfill довёл legacy-строки до снимка: у находки есть прогон, у стадии —
  // указатель, иначе результат прошлых версий пропал бы из портала.
  const legacyIssue = await db.queryOne('SELECT analysis_run_id FROM issues WHERE id = ?', 'ci-legacy-issue');
  if (!legacyIssue || !legacyIssue.analysis_run_id) fail('legacy-находка осталась без прогона — backfill не отработал');
  const pointer = await db.queryOne(
    `SELECT analysis_run_id FROM analysis_active_runs WHERE tender_id = ? AND scope = 'stage:1'`,
    tender.id,
  );
  if (!pointer) fail('backfill не поставил указатель актуального прогона стадии 1');
  if (pointer.analysis_run_id !== legacyIssue.analysis_run_id) {
    fail('указатель стадии ведёт не на тот прогон, которым размечена legacy-находка');
  }
  const legacyDraft = await db.queryOne('SELECT analysis_run_id FROM draft_issues WHERE id = ?', 'ci-legacy-draft');
  if (!legacyDraft || !legacyDraft.analysis_run_id) fail('legacy-строка конвейера осталась без pipeline-прогона');
  ok('legacy-результат подхвачен снимком (прогон + указатель на месте)');

  // Третий прогон — backfill не должен «нарастать» с каждой миграцией.
  const runsAfterFirst = Number((await db.queryOne('SELECT COUNT(*) AS c FROM analysis_runs')).c);
  const pointersAfterFirst = Number((await db.queryOne('SELECT COUNT(*) AS c FROM analysis_active_runs')).c);
  await runMigration();
  const third = await counts();
  for (const table of COUNTED_TABLES) {
    if (third[table] !== before[table]) {
      fail(`третья миграция изменила ${table}: было ${before[table]}, стало ${third[table]}`);
    }
  }
  const runsAfterSecond = Number((await db.queryOne('SELECT COUNT(*) AS c FROM analysis_runs')).c);
  const pointersAfterSecond = Number((await db.queryOne('SELECT COUNT(*) AS c FROM analysis_active_runs')).c);
  if (runsAfterSecond !== runsAfterFirst) {
    fail(`повторная миграция создала лишние прогоны: было ${runsAfterFirst}, стало ${runsAfterSecond}`);
  }
  if (pointersAfterSecond !== pointersAfterFirst) {
    fail(`повторная миграция создала лишние указатели: было ${pointersAfterFirst}, стало ${pointersAfterSecond}`);
  }
  ok('миграция населённой БД идемпотентна (backfill не дублируется)');
}

async function main() {
  const mode = process.argv.includes('--populated') ? 'populated'
    : process.argv.includes('--empty') ? 'empty' : null;
  if (!mode) {
    console.error('Использование: node scripts/ciMigrationCheck.js --empty | --populated');
    process.exit(1);
  }
  if (!(process.env.DATABASE_URL || '').trim()) {
    console.error('[migration-check] DATABASE_URL не задан — проверять нечего');
    process.exit(1);
  }
  console.log(`[migration-check] режим: ${mode}`);
  if (mode === 'empty') await checkEmpty();
  else await checkPopulated();
  console.log(`[migration-check] ${mode}: ВСЁ ХОРОШО`);
}

main()
  .then(() => db.close())
  .then(() => process.exit(0))
  .catch(async (err) => {
    if (!process.exitCode) console.error(`[migration-check] сорвалось: ${err.message}`);
    try { await db.close(); } catch { /* пул мог не открыться */ }
    process.exit(1);
  });

// Путь к скрипту в логах CI — чтобы падение было видно «откуда».
module.exports = { file: path.basename(__filename) };
