'use strict';

// Integration: миграция идемпотентна не только на ПУСТОЙ базе (это проверяет
// db.integration.test.js), но и на СУЩЕСТВУЮЩЕЙ базе С ДАННЫМИ, в т.ч. legacy-
// строками, которые появились до колонок снимков (analysis_run_id) и
// изоляции тенантов (tenders.tenant_id). Повторный прогон не должен ни падать,
// ни плодить/ронять данные (п.11 аудита).
//
// Отдельно проверяется backfill снимков анализа на СМЕШАННОЙ базе: один тендер
// уже размечен (реальный прогон + указатель), второй остался legacy. Раньше
// backfill стоял под глобальным guard'ом «в базе нет ни одного указателя» —
// достаточно было одному тендеру пройти анализ, и legacy-находки остальных
// исчезали из счётчиков и выгрузок навсегда (issuesRunFilter скоупит issues по
// указателям). Теперь backfill идёт отдельно по каждому тендеру и каждой стадии.
//
//   npm run test:integration    — без TEST_DATABASE_URL тесты SKIP
//   npm run verify:integration  — без TEST_DATABASE_URL тесты ПАДАЮТ

const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');

const { dbTestOptions, getDb, closeDb } = require('../helpers/testDb');
const analysisRuns = require('../../services/analysisRuns/analysisRunsService');
const tendersController = require('../../controllers/tendersController');
const exportService = require('../../services/exportService');

const OPTS = dbTestOptions();
// Тендер, который никогда не видел снимков: всё legacy (analysis_run_id IS NULL).
const TENDER_ID = 'migpop-tender';
// Тендер, который уже прошёл анализ на новой версии: реальный прогон + указатель.
const TENDER_MARKED = 'migpop-marked';
// Тендер с версии, где analysis_run_id у issues уже был, а указателей ещё не было:
// снимок настоящий, «актуального» среди них нет.
const TENDER_NOPTR = 'migpop-noptr';
// Синтетические id backfill'а детерминированы — их и ждём в БД.
const SYN_STAGE_RUN = `runbf_s1_${TENDER_ID}`;
const SYN_PIPELINE_RUN = `runbf_${TENDER_ID}`;

let markedRunId = null; // реальный stage-прогон размеченного тендера

async function countIssues(db, tenderId = TENDER_ID) {
  const r = await db.queryOne('SELECT COUNT(*) AS c FROM issues WHERE tender_id = ?', tenderId);
  return Number(r.c);
}

// Находки в АКТИВНОМ скоупе — тем же фильтром, что используют счётчики и выгрузки.
async function countActive(db, tenderId) {
  const rf = await analysisRuns.issuesRunFilter(tenderId, 'i');
  const r = await db.queryOne(
    `SELECT COUNT(*) AS c FROM issues i WHERE i.tender_id = ?${rf.sql}`, tenderId, ...rf.params,
  );
  return Number(r.c);
}

async function pointerOf(db, tenderId, scope) {
  const r = await db.queryOne(
    'SELECT analysis_run_id FROM analysis_active_runs WHERE tender_id = ? AND scope = ?', tenderId, scope,
  );
  return r ? r.analysis_run_id : null;
}

// Снимок «сколько чего в базе» — для проверки, что повтор миграции ничего не плодит.
async function snapshotCounts(db) {
  const ids = [TENDER_ID, TENDER_MARKED];
  const out = {};
  for (const [key, sql] of Object.entries({
    runs: 'SELECT COUNT(*) AS c FROM analysis_runs WHERE tender_id IN (?, ?)',
    pointers: 'SELECT COUNT(*) AS c FROM analysis_active_runs WHERE tender_id IN (?, ?)',
    issues: 'SELECT COUNT(*) AS c FROM issues WHERE tender_id IN (?, ?)',
    signals: 'SELECT COUNT(*) AS c FROM analysis_signals WHERE tender_id IN (?, ?)',
    drafts: 'SELECT COUNT(*) AS c FROM draft_issues WHERE tender_id IN (?, ?)',
    reviews: 'SELECT COUNT(*) AS c FROM issue_reviews WHERE tender_id IN (?, ?)',
    clusters: 'SELECT COUNT(*) AS c FROM issue_clusters WHERE tender_id IN (?, ?)',
    selfAnalysis: 'SELECT COUNT(*) AS c FROM self_analysis_results WHERE tender_id IN (?, ?)',
  })) {
    out[key] = Number((await db.queryOne(sql, ...ids)).c);
  }
  return out;
}

before(async () => {
  if (OPTS.skip) return;
  const { runMigration } = require('../../db/migrate');
  await runMigration(); // схема уже есть — колонки, на которые вставляем ниже
  const db = getDb();
  await db.queryRun('DELETE FROM review_decisions WHERE id IN (?, ?)', 'migpop-dec', 'migpop-cdec');
  await db.queryRun('DELETE FROM tenders WHERE id IN (?, ?, ?)', TENDER_ID, TENDER_MARKED, TENDER_NOPTR);
  const now = new Date().toISOString();
  await db.queryRun(
    'INSERT INTO tenders (id, title, status, created_at) VALUES (?, ?, ?, ?)',
    TENDER_ID, 'Миграция на населённой БД', 'draft', now,
  );
  // Документ + характеристика (проверяем идемпотентные ALTER/backfill колонок).
  await db.queryRun(
    `INSERT INTO documents (id, tender_id, doc_type, name, file_path, uploaded_at, processing_status)
     VALUES (?, ?, 'tz', 'ТЗ.md', '/tmp/tz.md', ?, 'extracted')`,
    'migpop-doc', TENDER_ID, now,
  );
  await db.queryRun(
    'INSERT INTO characteristics (id, tender_id, name, value) VALUES (?, ?, ?, ?)',
    'migpop-char', TENDER_ID, 'Класс бетона', 'B25',
  );
  // Legacy-issue БЕЗ analysis_run_id (как до появления снимков анализа).
  await db.queryRun(
    `INSERT INTO issues (id, tender_id, analysis_stage, source_fragment, problem_type, criticality, review_status)
     VALUES (?, ?, 1, 'Демонтаж не учтён', 'не_учтено_в_кп', 'high', 'pending')`,
    'migpop-issue', TENDER_ID,
  );
  // Legacy issue-level решение по этому issue.
  await db.queryRun(
    `INSERT INTO review_decisions (id, issue_id, decision, decided_at) VALUES (?, ?, 'accept', ?)`,
    'migpop-dec', 'migpop-issue', now,
  );
  // Legacy-сигнал того же места (слой signals появился раньше снимков).
  await db.queryRun(
    `INSERT INTO analysis_signals (id, tender_id, analysis_stage, signal_type, source_entity_type,
                                   source_entity_id, source_fragment, created_at)
     VALUES (?, ?, 1, 'coverage', 'issue', ?, 'Демонтаж не учтён', ?)`,
    'migpop-sig', TENDER_ID, 'migpop-issue', now,
  );
  // Legacy производные слои конвейера (draft → critic → clustering → self-analysis).
  await db.queryRun(
    `INSERT INTO draft_issues (id, tender_id, tz_clause, source_fragment, problem_type, created_at)
     VALUES (?, ?, '1.2 Объём работ', 'Демонтаж не учтён', 'не_учтено_в_кп', ?)`,
    'migpop-draft', TENDER_ID, now,
  );
  await db.queryRun(
    `INSERT INTO issue_reviews (id, tender_id, draft_issue_id, business_impact, display_priority, created_at)
     VALUES (?, ?, ?, 'high', 'high', ?)`,
    'migpop-review', TENDER_ID, 'migpop-draft', now,
  );
  await db.queryRun(
    `INSERT INTO issue_clusters (id, tender_id, tz_clause, cluster_title, cluster_key,
                                 overall_criticality, item_count, created_at)
     VALUES (?, ?, '1.2 Объём работ', 'Демонтаж не учтён', 'place1::coverage', 'high', 1, ?)`,
    'migpop-clu', TENDER_ID, now,
  );
  await db.queryRun(
    `INSERT INTO issue_cluster_items (id, cluster_id, draft_issue_id, item_role, created_at)
     VALUES (?, ?, ?, 'primary', ?)`,
    'migpop-cli', 'migpop-clu', 'migpop-draft', now,
  );
  await db.queryRun(
    `INSERT INTO self_analysis_results (id, tender_id, cluster_id, finding_type, comment, created_at)
     VALUES (?, ?, ?, 'weak_cluster', 'Основание слабое', ?)`,
    'migpop-self', TENDER_ID, 'migpop-clu', now,
  );
  // Кластерное решение БЕЗ analysis_run_id / cluster_key (backfill берёт их из кластера).
  await db.queryRun(
    `INSERT INTO review_decisions (id, cluster_id, decision, decided_at) VALUES (?, ?, 'accept', ?)`,
    'migpop-cdec', 'migpop-clu', now,
  );

  // Второй тендер — УЖЕ размечен: реальный stage-прогон + указатель на него.
  // Плюс своя legacy-строка той же стадии: backfill не должен подмешать её в
  // чужой актуальный снимок и не должен перебить существующий указатель.
  await db.queryRun(
    'INSERT INTO tenders (id, title, status, created_at) VALUES (?, ?, ?, ?)',
    TENDER_MARKED, 'Уже размеченный тендер', 'draft', now,
  );
  markedRunId = await analysisRuns.beginRun(TENDER_MARKED, analysisRuns.stageScope(1), { stage: 1 });
  await db.queryRun(
    `INSERT INTO issues (id, tender_id, analysis_run_id, analysis_stage, source_fragment, problem_type, criticality, review_status)
     VALUES (?, ?, ?, 1, 'Учтён в актуальном снимке', 'не_учтено_в_кп', 'high', 'pending')`,
    'migmark-issue', TENDER_MARKED, markedRunId,
  );
  await analysisRuns.activateRun(TENDER_MARKED, analysisRuns.stageScope(1), markedRunId, {});
  await db.queryRun(
    `INSERT INTO issues (id, tender_id, analysis_stage, source_fragment, problem_type, criticality, review_status)
     VALUES (?, ?, 1, 'Старая находка вне снимка', 'не_учтено_в_кп', 'medium', 'pending')`,
    'migmark-legacy', TENDER_MARKED,
  );

  // Третий тендер — снимок есть, указателя нет (обновление с версии до
  // analysis_active_runs). Строки уже размечены, «чинить» нужно только указатель.
  await db.queryRun(
    'INSERT INTO tenders (id, title, status, created_at) VALUES (?, ?, ?, ?)',
    TENDER_NOPTR, 'Снимок без указателя', 'draft', now,
  );
  await db.queryRun(
    `INSERT INTO analysis_runs (id, tender_id, stage, kind, started_at, finished_at, status)
     VALUES (?, ?, 2, 'stage', ?, ?, 'completed')`,
    'migptr-run', TENDER_NOPTR, now, now,
  );
  await db.queryRun(
    `INSERT INTO issues (id, tender_id, analysis_run_id, analysis_stage, source_fragment, problem_type, criticality, review_status)
     VALUES (?, ?, ?, 2, 'Находка без указателя', 'не_учтено_в_кп', 'high', 'pending')`,
    'migptr-issue', TENDER_NOPTR, 'migptr-run',
  );
});

after(async () => {
  if (OPTS.skip) return;
  const db = getDb();
  // review_decisions по cluster_id — без FK, каскадом тендера не удалятся.
  await db.queryRun('DELETE FROM review_decisions WHERE id IN (?, ?)', 'migpop-dec', 'migpop-cdec');
  await db.queryRun('DELETE FROM tenders WHERE id IN (?, ?, ?)', TENDER_ID, TENDER_MARKED, TENDER_NOPTR);
  await closeDb();
});

test('runMigration на населённой БД (legacy-данные) идемпотентна: два повторных прогона', OPTS, async () => {
  const { runMigration } = require('../../db/migrate');
  const db = getDb();

  const issuesBefore = await countIssues(db);
  assert.equal(issuesBefore, 1, 'исходно один legacy-issue');

  // Повторные прогоны на уже населённой базе не должны ни падать, ни менять данные.
  await runMigration();
  await runMigration();

  assert.equal(await countIssues(db), 1, 'миграция не должна дублировать/удалять issues');

  // Идемпотентные ALTER действительно добавили колонки снимков/происхождения.
  const cols = await db.queryAll(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'issues'`,
  );
  assert.ok(cols.map((c) => c.column_name).includes('analysis_run_id'));

  const docCols = await db.queryAll(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'documents'`,
  );
  const docColNames = docCols.map((c) => c.column_name);
  for (const c of ['sha256', 'size_bytes', 'av_status', 'uploaded_by', 'import_report']) {
    assert.ok(docColNames.includes(c), `documents.${c} должна существовать после миграции`);
  }

  // tenders.tenant_id — NOT NULL с DEFAULT: существующий тендер получил тенант,
  // строка не осталась «ничьей».
  const t = await db.queryOne('SELECT tenant_id FROM tenders WHERE id = ?', TENDER_ID);
  assert.ok(t.tenant_id, 'существующий тендер должен иметь tenant_id после миграции');

  // Legacy-решение по issue не потеряно.
  const dec = await db.queryOne('SELECT decision FROM review_decisions WHERE id = ?', 'migpop-dec');
  assert.equal(dec.decision, 'accept');
});

test('backfill: legacy issue получает синтетический stage-прогон, указатель и попадает в активный скоуп', OPTS, async () => {
  const db = getDb();

  // 1. Синтетический stage-прогон создан и он completed (иначе снимок «не готов»).
  const run = await db.queryOne('SELECT * FROM analysis_runs WHERE id = ?', SYN_STAGE_RUN);
  assert.ok(run, 'синтетический stage-прогон должен быть создан');
  assert.equal(run.kind, 'stage');
  assert.equal(Number(run.stage), 1);
  assert.equal(run.status, 'completed');
  assert.equal(run.superseded_at, null, 'синтетический прогон не должен быть сразу архивирован');

  // 2. Legacy-строки стадии размечены этим прогоном.
  const issue = await db.queryOne('SELECT analysis_run_id FROM issues WHERE id = ?', 'migpop-issue');
  assert.equal(issue.analysis_run_id, SYN_STAGE_RUN, 'legacy issue должен получить analysis_run_id');
  const sig = await db.queryOne('SELECT analysis_run_id FROM analysis_signals WHERE id = ?', 'migpop-sig');
  assert.equal(sig.analysis_run_id, SYN_STAGE_RUN, 'legacy сигнал должен получить тот же stage-прогон');

  // 3. Указатель стадии создан → находка входит в АКТИВНЫЙ снимок.
  assert.equal(await pointerOf(db, TENDER_ID, 'stage:1'), SYN_STAGE_RUN);
  assert.equal(await countActive(db, TENDER_ID), 1, 'legacy issue виден через issuesRunFilter');
});

test('backfill: восстановленная находка попадает в API-счётчики и в issue-выгрузки', OPTS, async () => {
  // Счётчики тендера (GET /api/tenders/:id) — те же, что видит инженер в UI.
  const tender = await tendersController.getTenderById(TENDER_ID);
  assert.equal(Number(tender.counts.issues_total), 1, 'счётчик находок видит восстановленную находку');
  assert.equal(Number(tender.counts.issues_pending), 1, 'она же считается «в работе»');

  // Issue-level выгрузки (fallback-путь экспорта) идут через тот же run-фильтр.
  const csv = await exportService.exportCsv(TENDER_ID, { source: 'issues' });
  assert.equal(csv.source, 'issues');
  assert.ok(csv.content.includes('Демонтаж не учтён'), 'CSV-выгрузка содержит восстановленную находку');

  const jsonOut = await exportService.exportJson(TENDER_ID, { source: 'issues' });
  const json = JSON.parse(jsonOut.content);
  assert.equal(json.issues.length, 1, 'JSON-выгрузка содержит ровно одну находку');
  assert.equal(json.issues[0].id, 'migpop-issue');
  assert.equal(json.issues[0].decision, 'accept', 'решение инженера подтянулось к находке');
});

test('backfill: производные слои конвейера получают синтетический pipeline-прогон и указатель', OPTS, async () => {
  const db = getDb();

  const run = await db.queryOne('SELECT * FROM analysis_runs WHERE id = ?', SYN_PIPELINE_RUN);
  assert.ok(run, 'синтетический pipeline-прогон должен быть создан');
  assert.equal(run.kind, 'pipeline');
  assert.equal(run.stage, null);
  assert.equal(run.status, 'completed');

  for (const [table, id] of [
    ['draft_issues', 'migpop-draft'],
    ['issue_reviews', 'migpop-review'],
    ['issue_clusters', 'migpop-clu'],
    ['self_analysis_results', 'migpop-self'],
  ]) {
    const row = await db.queryOne(`SELECT analysis_run_id FROM ${table} WHERE id = ?`, id);
    assert.equal(row.analysis_run_id, SYN_PIPELINE_RUN, `${table} должен быть размечен pipeline-прогоном`);
  }
  assert.equal(await pointerOf(db, TENDER_ID, 'pipeline'), SYN_PIPELINE_RUN);

  // Кластерное решение получило прогон и стабильную сигнатуру из своего кластера.
  const cdec = await db.queryOne(
    'SELECT analysis_run_id, cluster_key FROM review_decisions WHERE id = ?', 'migpop-cdec',
  );
  assert.equal(cdec.analysis_run_id, SYN_PIPELINE_RUN);
  assert.equal(cdec.cluster_key, 'place1::coverage');
});

test('смешанная БД: размеченный тендер сохраняет свой указатель, legacy-тендер получает синтетический', OPTS, async () => {
  const db = getDb();

  // Указатель размеченного тендера НЕ перебит синтетическим прогоном.
  assert.equal(await pointerOf(db, TENDER_MARKED, 'stage:1'), markedRunId,
    'существующий корректный указатель backfill не трогает');
  const marked = await db.queryOne('SELECT analysis_run_id FROM issues WHERE id = ?', 'migmark-issue');
  assert.equal(marked.analysis_run_id, markedRunId, 'уже размеченная строка не переписывается');

  // Legacy-строка ТОГО ЖЕ тендера и той же стадии размечена синтетическим прогоном,
  // но в чужой актуальный снимок не подмешана.
  const legacy = await db.queryOne('SELECT analysis_run_id FROM issues WHERE id = ?', 'migmark-legacy');
  assert.equal(legacy.analysis_run_id, `runbf_s1_${TENDER_MARKED}`, 'legacy-строка тоже получает прогон');
  assert.equal(await countActive(db, TENDER_MARKED), 1,
    'в активном снимке размеченного тендера только его собственная находка');

  // При этом legacy-тендер обслужен независимо: глобального guard'а больше нет.
  assert.equal(await countActive(db, TENDER_ID), 1, 'legacy-тендер размечен, хотя указатели в базе уже были');
});

test('смешанная БД: реальный снимок без указателя получает указатель на СВОЙ прогон, а не синтетический', OPTS, async () => {
  const db = getDb();

  assert.equal(await pointerOf(db, TENDER_NOPTR, 'stage:2'), 'migptr-run',
    'указатель ставится на настоящий completed-прогон стадии');
  const issue = await db.queryOne('SELECT analysis_run_id FROM issues WHERE id = ?', 'migptr-issue');
  assert.equal(issue.analysis_run_id, 'migptr-run', 'размеченная строка осталась в своём прогоне');
  const synthetic = await db.queryOne(
    `SELECT COUNT(*) AS c FROM analysis_runs WHERE tender_id = ? AND id LIKE 'runbf_%'`, TENDER_NOPTR,
  );
  assert.equal(Number(synthetic.c), 0, 'синтетический прогон здесь не нужен — legacy-строк нет');
  assert.equal(await countActive(db, TENDER_NOPTR), 1, 'находка вернулась в активный скоуп');
});

test('backfill идемпотентен: два повторных запуска миграции не создают дублей', OPTS, async () => {
  const { runMigration } = require('../../db/migrate');
  const db = getDb();

  const before = await snapshotCounts(db);
  const pointersBefore = await db.queryAll(
    'SELECT tender_id, scope, analysis_run_id FROM analysis_active_runs WHERE tender_id IN (?, ?) ORDER BY tender_id, scope',
    TENDER_ID, TENDER_MARKED,
  );

  await runMigration();
  await runMigration();

  assert.deepEqual(await snapshotCounts(db), before, 'повтор миграции не добавляет и не удаляет строк');
  const pointersAfter = await db.queryAll(
    'SELECT tender_id, scope, analysis_run_id FROM analysis_active_runs WHERE tender_id IN (?, ?) ORDER BY tender_id, scope',
    TENDER_ID, TENDER_MARKED,
  );
  assert.deepEqual(pointersAfter, pointersBefore, 'указатели после повторов те же самые');

  // Синтетический прогон ровно один на (тендер + стадию) — id детерминирован.
  const dup = await db.queryOne(
    `SELECT COUNT(*) AS c FROM analysis_runs WHERE tender_id = ? AND kind = 'stage' AND stage = 1`,
    TENDER_ID,
  );
  assert.equal(Number(dup.c), 1, 'повтор не плодит синтетические stage-прогоны');
  assert.equal(await countActive(db, TENDER_ID), 1, 'находка не задвоилась в активном скоупе');
});
