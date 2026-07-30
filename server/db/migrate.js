'use strict';

const fs = require('fs');
const path = require('path');

// .env читается ТОЛЬКО при самостоятельном запуске (npm run migrate).
// При импорте модуля (server.js, тесты) окружение настраивает вызывающий —
// иначе production-.env незаметно протекал бы в тестовый процесс.
if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
}

const db = require('./connection');

// Гонка одновременных миграций. `CREATE TABLE IF NOT EXISTS` в PostgreSQL не
// атомарен относительно другого такого же вызова: два процесса, применяющих
// схему к ПУСТОЙ базе одновременно (несколько integration-файлов, две реплики
// на деплое), получают duplicate key ... pg_type_typname_nsp_index. Объект при
// этом создаётся — достаточно повторить операцию один раз.
const DDL_RACE_CODES = new Set([
  '23505', // unique_violation в системном каталоге
  '42P07', // duplicate_table
  '42701', // duplicate_column
  '42P06', // duplicate_schema
  '40P01', // deadlock_detected
]);

async function execTolerant(sql) {
  try {
    await db.exec(sql);
  } catch (err) {
    if (!DDL_RACE_CODES.has(err.code)) throw err;
    await new Promise((r) => setTimeout(r, 150));
    await db.exec(sql); // объект уже есть — второй проход проходит по IF NOT EXISTS
  }
}

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
  try {
    await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type};`);
  } catch (err) {
    // Столбец добавил параллельный процесс между проверкой и ALTER — не ошибка.
    if (err.code === '42701') return false;
    throw err;
  }
  console.log(`[migrate] ${table}.${column} added`);
  return true;
}

async function ensureIndex(name, table, columns) {
  await execTolerant(`CREATE INDEX IF NOT EXISTS ${name} ON ${table}(${columns});`);
}

// Идемпотентно снимает NOT NULL со столбца (если он сейчас NOT NULL).
async function dropNotNull(table, column) {
  const r = await db.queryOne(
    `SELECT is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ? AND column_name = ?`,
    table,
    column,
  );
  if (!r || r.is_nullable === 'YES') return false;
  await db.exec(`ALTER TABLE ${table} ALTER COLUMN ${column} DROP NOT NULL;`);
  console.log(`[migrate] ${table}.${column} NOT NULL dropped`);
  return true;
}

// --- Backfill снимков анализа (analysis_run_id + указатели) ------------------
//
// Раньше здесь стоял ГЛОБАЛЬНЫЙ guard `SELECT COUNT(*) FROM analysis_active_runs`:
// backfill выполнялся, только пока в базе НЕТ НИ ОДНОГО указателя. На пустой базе
// это работало, на населённой — нет. Достаточно одному тендеру получить указатель
// (первый же реальный анализ после обновления) — и backfill молча пропускался
// НАВСЕГДА: все прочие тендеры оставались с legacy-строками (analysis_run_id IS
// NULL), а их находки исчезали из счётчиков и выгрузок, потому что issuesRunFilter
// скоупит issues по указателям, и строка без прогона не входит ни в один снимок.
// Смешанная база (часть тендеров размечена, часть нет) — нормальное состояние
// обновляемого стенда, а не исключение.
//
// Guard'а больше нет. Backfill идемпотентен САМ ПО СЕБЕ и выполняется ОТДЕЛЬНО
// для каждого тендера и каждой стадии — по факту наличия legacy-строк, а не по
// состоянию базы в целом:
//   • id синтетических прогонов детерминированы (тендер + стадия) → повтор
//     миграции переиспользует их (ON CONFLICT (id) DO NOTHING), дублей нет;
//   • строки размечаются только WHERE analysis_run_id IS NULL → уже размеченная
//     строка (она принадлежит ЧУЖОМУ снимку) не трогается;
//   • указатели ставятся только ON CONFLICT (tender_id, scope) DO NOTHING →
//     существующий корректный указатель не перебивается.
// Имя pipeline-прогона ('runbf_' || tender_id) сохранено от прежней версии
// backfill'а: база, мигрированная ею, не получает ВТОРОЙ синтетический прогон.

// ISO-строка «сейчас» на стороне БД (формат как у new Date().toISOString()).
const BF_NOW = `to_char((now() at time zone 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

// (тендер + стадия), где есть строки БЕЗ прогона. issues.analysis_stage — NOT NULL;
// у сигнала стадия может быть пустой, такой сигнал относим к стадии 1 (иначе он не
// попадёт вообще ни в один снимок — чтения сигналов идут по id stage-прогонов).
const STAGE_ORPHANS = `
  SELECT DISTINCT tender_id, analysis_stage AS stage
    FROM issues
   WHERE analysis_run_id IS NULL AND analysis_stage IS NOT NULL
  UNION
  SELECT DISTINCT tender_id, COALESCE(analysis_stage, 1) AS stage
    FROM analysis_signals
   WHERE analysis_run_id IS NULL`;

// Тендеры, у которых есть legacy-строки производных слоёв конвейера.
const PIPELINE_ORPHANS = `
  SELECT tender_id FROM draft_issues          WHERE analysis_run_id IS NULL
  UNION SELECT tender_id FROM issue_reviews         WHERE analysis_run_id IS NULL
  UNION SELECT tender_id FROM issue_clusters        WHERE analysis_run_id IS NULL
  UNION SELECT tender_id FROM self_analysis_results WHERE analysis_run_id IS NULL`;

const DERIVED_TABLES = ['draft_issues', 'issue_reviews', 'issue_clusters', 'self_analysis_results'];

async function backfillAnalysisSnapshots() {
  const stats = await db.transaction(async (tx) => {
    const s = {};
    const count = async (sql) => Number((await tx.queryRun(sql)).changes || 0);

    // Миграцию могут запустить НЕСКОЛЬКО процессов одновременно (сервер +
    // отдельный воркер на старте, параллельные тестовые файлы). Backfill из
    // нескольких зависимых шагов (вставка синтетических прогонов → разметка
    // строк по ним) должен идти строго по одному: транзакционный advisory-lock
    // сериализует конкурентов, второй просто дождётся и увидит IS NULL-драйверы
    // уже пустыми.
    await tx.queryRun(`SELECT pg_advisory_xact_lock(hashtext('tzopti:migration:backfill'))`);

    // 1. Указатель стадии по РЕАЛЬНОМУ прогону — там, где указателя ещё нет. Это
    //    база, обновлённая с версии, где issues.analysis_run_id уже был, а
    //    analysis_active_runs ещё не было: снимки есть, «актуального» среди них
    //    нет. Берём последний completed и НЕ архивированный прогон стадии;
    //    архивные (resetStage, debug-сборка) пропускаем сознательно — иначе
    //    миграция воскрешала бы снятый инженером указатель.
    s.stage_pointers_from_runs = await count(`
      INSERT INTO analysis_active_runs (tender_id, scope, documents_revision_id, config_version, analysis_run_id, updated_at)
      SELECT tender_id, 'stage:' || stage, documents_revision_id, config_version, id, COALESCE(finished_at, started_at)
        FROM (
          SELECT id, tender_id, stage, documents_revision_id, config_version, started_at, finished_at,
                 ROW_NUMBER() OVER (PARTITION BY tender_id, stage ORDER BY started_at DESC, id DESC) AS rn
            FROM analysis_runs
           WHERE kind = 'stage' AND stage IS NOT NULL AND status = 'completed' AND superseded_at IS NULL
        ) t
       WHERE rn = 1
      ON CONFLICT (tender_id, scope) DO NOTHING`);

    // 2. Синтетический completed stage-прогон на каждую (тендер + стадию) с
    //    legacy-строками. documents_revision_id / config_version остаются NULL:
    //    ревизия legacy-прогона неизвестна, и pipelineManifest честно пометит
    //    такую стадию stage_revision_unknown (её надо пересчитать), а не выдаст
    //    восстановленный снимок за полноценный вход конвейера.
    s.stage_runs = await count(`
      INSERT INTO analysis_runs (id, tender_id, stage, kind, started_at, finished_at, status, summary)
      SELECT 'runbf_s' || stage || '_' || tender_id, tender_id, stage, 'stage', ${BF_NOW}, ${BF_NOW}, 'completed',
             '{"backfill":true,"kind":"stage"}'
        FROM (${STAGE_ORPHANS}) o
      ON CONFLICT (id) DO NOTHING`);

    // 3. Недостающий указатель стадии — на этот синтетический прогон. Идёт ДО
    //    разметки строк (шаг 4), потому что драйвер считается по IS NULL. Если у
    //    стадии указатель уже есть (шаг 1 или реальный анализ), он остаётся, а
    //    legacy-строки лежат в своём синтетическом прогоне вне активного снимка —
    //    подмешивать их в чужой актуальный снимок нельзя.
    s.stage_pointers_synthetic = await count(`
      INSERT INTO analysis_active_runs (tender_id, scope, documents_revision_id, config_version, analysis_run_id, updated_at)
      SELECT tender_id, 'stage:' || stage, NULL, NULL, 'runbf_s' || stage || '_' || tender_id, ${BF_NOW}
        FROM (${STAGE_ORPHANS}) o
      ON CONFLICT (tender_id, scope) DO NOTHING`);

    // 4. Разметка legacy-строк стадий (issues + signals) своим stage-прогоном.
    //    EXISTS-гард: помечаем только строки, чей синтетический прогон реально
    //    существует, — если параллельная сессия успела удалить тендер вместе с
    //    его прогонами между шагами, разметка их пропустит, а не упадёт на FK.
    s.issues = await count(`
      UPDATE issues SET analysis_run_id = 'runbf_s' || analysis_stage || '_' || tender_id
       WHERE analysis_run_id IS NULL AND analysis_stage IS NOT NULL
         AND EXISTS (SELECT 1 FROM analysis_runs r
                      WHERE r.id = 'runbf_s' || issues.analysis_stage || '_' || issues.tender_id)`);
    s.signals = await count(`
      UPDATE analysis_signals SET analysis_run_id = 'runbf_s' || COALESCE(analysis_stage, 1) || '_' || tender_id
       WHERE analysis_run_id IS NULL
         AND EXISTS (SELECT 1 FROM analysis_runs r
                      WHERE r.id = 'runbf_s' || COALESCE(analysis_signals.analysis_stage, 1) || '_' || analysis_signals.tender_id)`);

    // 5. Производные слои конвейера: синтетический pipeline-прогон + указатель.
    s.pipeline_runs = await count(`
      INSERT INTO analysis_runs (id, tender_id, stage, kind, started_at, finished_at, status, summary)
      SELECT 'runbf_' || tender_id, tender_id, NULL, 'pipeline', ${BF_NOW}, ${BF_NOW}, 'completed',
             '{"backfill":true,"kind":"pipeline"}'
        FROM (${PIPELINE_ORPHANS}) o
      ON CONFLICT (id) DO NOTHING`);
    s.pipeline_pointers = await count(`
      INSERT INTO analysis_active_runs (tender_id, scope, documents_revision_id, config_version, analysis_run_id, updated_at)
      SELECT tender_id, 'pipeline', NULL, NULL, 'runbf_' || tender_id, ${BF_NOW}
        FROM (${PIPELINE_ORPHANS}) o
      ON CONFLICT (tender_id, scope) DO NOTHING`);
    for (const table of DERIVED_TABLES) {
      s[table] = await count(
        `UPDATE ${table} SET analysis_run_id = 'runbf_' || tender_id
          WHERE analysis_run_id IS NULL
            AND EXISTS (SELECT 1 FROM analysis_runs r WHERE r.id = 'runbf_' || ${table}.tender_id)`,
      );
    }

    // 6. Решения кластерного пути: run_id + cluster_key берём из кластера.
    s.decisions = await count(`
      UPDATE review_decisions AS rd
         SET analysis_run_id = c.analysis_run_id,
             cluster_key = COALESCE(rd.cluster_key, c.cluster_key)
        FROM issue_clusters AS c
       WHERE rd.cluster_id = c.id AND rd.analysis_run_id IS NULL`);
    return s;
  });

  const touched = Object.entries(stats).filter(([, n]) => n > 0);
  if (touched.length) {
    console.log(`[migrate] analysis snapshots backfilled: ${touched.map(([k, n]) => `${k}=${n}`).join(', ')}`);
  }
}

// --- Backfill модели материальности (impact × evidence → verdict) ------------
//
// Старые строки конвейера оценивались прежней моделью: публикацию решал
// display_priority (в нём смешаны criticality агента и confidence сборки).
// Перенос БЕЗОПАСНЫЙ в трёх смыслах:
//   1. ничего не удаляется и не пересчитывается заново — заполняются только
//      пустые колонки (WHERE verdict IS NULL), поэтому миграция идемпотентна и
//      НЕ затирает вердикты, уже посчитанные новым кодом;
//   2. то, что инженер видел как важное (display_priority critical|high при
//      show_to_engineer=1), остаётся видимым: high + evidence medium → publish.
//      Прежнее medium уходит в «На проверку», прежнее low/скрытое — в скрытые
//      с причиной. Инженер не теряет ни одной строки — меняется только полка;
//   3. вердикт считает ТА ЖЕ матрица (materiality.fromLegacyPriority →
//      resolveVerdict), исключений из правил миграция не создаёт. В причине
//      стоит пометка LEGACY_REASON_PREFIX — видно, что уровень перенесён, а не
//      рассчитан по материальным критериям (пересборка конвейера уточнит).
//
// draft_issues переносятся иначе: у них нет приоритета вообще, поэтому
// impact_level остаётся ПУСТЫМ («агент не оценил» ≠ «влияния нет»), вердикт —
// verify, а доказательность выводится из привязки к тексту ТЗ и наличия
// обоснования — ровно как это делает unifiedIssueBuilder для новых строк.
async function backfillMateriality() {
  const {
    fromLegacyPriority,
    IMPACT_LEVELS,
  } = require('../services/review/materiality');

  const stats = { draft_issues: 0, issue_reviews: 0, issue_clusters: 0 };

  // 1) draft_issues — мнение агента отсутствует, ставим verify.
  const drafts = await db.queryRun(
    `UPDATE draft_issues
        SET verdict = 'verify',
            evidence_level = CASE
              WHEN paragraph_index IS NOT NULL AND source_fragment IS NOT NULL AND basis IS NOT NULL
                THEN 'medium' ELSE 'weak' END,
            impact_dimensions = COALESCE(impact_dimensions, '[]'),
            required_action = COALESCE(required_action, 'ask_customer')
      WHERE verdict IS NULL`,
  );
  stats.draft_issues = (drafts && (drafts.changes ?? drafts.rowCount)) || 0;

  // 2) issue_reviews / issue_clusters — по прежнему приоритету. Комбинаций
  // немного (приоритет × показывался/нет), поэтому вердикт считается ОДИН раз
  // чистой функцией на комбинацию, а в БД уходит по одному UPDATE на неё.
  const priorities = [...IMPACT_LEVELS, null];
  const targets = [
    {
      table: 'issue_reviews',
      priorityCol: 'display_priority',
      impactCol: 'impact_level',
      evidenceCol: 'evidence_level',
    },
    {
      table: 'issue_clusters',
      priorityCol: 'overall_criticality',
      impactCol: 'overall_impact_level',
      evidenceCol: 'overall_evidence_level',
    },
  ];
  for (const t of targets) {
    for (const priority of priorities) {
      for (const shown of [true, false]) {
        const m = fromLegacyPriority({ displayPriority: priority, shownToEngineer: shown });
        const priorityCond = priority === null ? `${t.priorityCol} IS NULL` : `${t.priorityCol} = ?`;
        // show_to_engineer NULL считаем «показывалось» (колонка DEFAULT 1).
        const shownCond = `COALESCE(show_to_engineer, 1) = ${shown ? 1 : 0}`;
        // eslint-disable-next-line no-await-in-loop
        const res = await db.queryRun(
          // show_to_engineer приводим к новому вердикту: колонку читают клиент и
          // выгрузки, и «показывать» обязано означать ровно verdict='publish' —
          // иначе прежнее medium осталось бы помеченным как видимое, хотя новый
          // режим «Значимые» его уже не показывает.
          `UPDATE ${t.table}
              SET verdict = ?, ${t.impactCol} = ?, ${t.evidenceCol} = ?,
                  publication_reason = ?, suppression_reason = ?, required_action = ?,
                  show_to_engineer = ?,
                  impact_dimensions = COALESCE(impact_dimensions, '[]')
            WHERE verdict IS NULL AND ${priorityCond} AND ${shownCond}`,
          m.verdict, m.impact_level, m.evidence_level,
          m.publication_reason, m.suppression_reason, m.required_action,
          m.verdict === 'publish' ? 1 : 0,
          ...(priority === null ? [] : [priority]),
        );
        stats[t.table] += (res && (res.changes ?? res.rowCount)) || 0;
      }
    }
  }

  const total = stats.draft_issues + stats.issue_reviews + stats.issue_clusters;
  if (total > 0) {
    console.log(
      `[migrate] материальность: перенесено строк — draft_issues ${stats.draft_issues}, ` +
        `issue_reviews ${stats.issue_reviews}, issue_clusters ${stats.issue_clusters}`,
    );
  }
  return stats;
}

async function runMigration() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await execTolerant(sql);

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
  // Раунды импорта Q&A: записи не удаляются, а сменяют статус (active |
  // superseded | cancelled); DEFAULT 'active' бэкфиллит существующие строки.
  await ensureColumn('qa_entries', 'qa_import_id', 'TEXT');
  await ensureColumn('qa_entries', 'status', "TEXT DEFAULT 'active'");
  await ensureColumn('qa_entries', 'supersedes_entry_id', 'TEXT');

  // Отчёт структурного импорта документа (сейчас — ВОР, services/vor):
  // сколько позиций, по каким листам, где найдена шапка, предупреждения.
  await ensureColumn('documents', 'import_report', 'TEXT');

  // section_path — для Стадии 1 (LLM-агент GPT-4o): путь заголовков из .md ТЗ.
  // Сохраняется как «1. Введение › 1.2 Объём работ», NULL для старых rule-based записей.
  await ensureColumn('issues', 'section_path', 'TEXT');

  // target_text — выбранная инженером подчасть фрагмента для delete/edit
  // (NULL = действие на весь фрагмент, как раньше).
  await ensureColumn('review_decisions', 'target_text', 'TEXT');

  // Привязка исключений ТЗ к конкретной РЕВИЗИИ документа: исключения одной
  // версии не должны применяться к другой. Плюс стабильный id узла + хэш
  // исходного текста (для перепривязки/подтверждения) и флаги устаревания.
  await ensureColumn('tz_excluded_ranges', 'document_revision_id', 'TEXT');
  await ensureColumn('tz_excluded_ranges', 'node_id', 'TEXT');
  await ensureColumn('tz_excluded_ranges', 'source_text_hash', 'TEXT');
  await ensureColumn('tz_excluded_ranges', 'stale', 'INTEGER DEFAULT 0');
  await ensureColumn('tz_excluded_ranges', 'needs_confirmation', 'INTEGER DEFAULT 0');
  await ensureIndex('idx_excluded_revision', 'tz_excluded_ranges', 'tender_id, document_revision_id');

  // Этап 6: review/export переходят на issue_clusters как основной результат.
  //   review_decisions.cluster_id — новый primary-адресат решения (issue_id → legacy).
  //   issue_clusters.cluster_key  — стабильная сигнатура группы (основа детерминированного id).
  await ensureColumn('review_decisions', 'cluster_id', 'TEXT');
  await ensureColumn('issue_clusters', 'cluster_key', 'TEXT');
  await ensureIndex('idx_decisions_cluster', 'review_decisions', 'cluster_id');
  // issue_id больше не обязателен (решение может быть привязано к cluster_id).
  await dropNotNull('review_decisions', 'issue_id');

  // Неизменяемые снимки анализа (analysis_run_id). Каждый анализ — снимок с
  // прогоном; указатель analysis_active_runs хранит актуальный прогон на
  // (тендер + scope + ревизия документов + версия конфигурации). Производные
  // слои привязываются к pipeline-прогону; issues/signals — к stage-прогону
  // (у них analysis_run_id уже был). См. services/analysisRuns/analysisRunsService.js.
  await ensureColumn('analysis_runs', 'kind', "TEXT DEFAULT 'stage'");
  await ensureColumn('analysis_runs', 'documents_revision_id', 'TEXT');
  await ensureColumn('analysis_runs', 'config_version', 'TEXT');
  await ensureColumn('analysis_runs', 'superseded_at', 'TEXT');
  // Manifest входов прогона: для pipeline-прогона — ТОЧНЫЙ набор stage-прогонов
  // (стадия + analysis_run_id + ревизия документов + версия конфигурации + статус),
  // зафиксированный на старте. Финализатор сверяет его перед активацией, поэтому
  // набор обязан переживать смену процесса (сборка идёт задачами очереди).
  // См. services/pipeline/pipelineManifest.js.
  await ensureColumn('analysis_runs', 'inputs_manifest', 'TEXT');
  await dropNotNull('analysis_runs', 'stage'); // pipeline-прогон: stage=NULL
  await ensureColumn('draft_issues', 'analysis_run_id', 'TEXT');
  await ensureColumn('issue_reviews', 'analysis_run_id', 'TEXT');
  await ensureColumn('issue_clusters', 'analysis_run_id', 'TEXT');
  await ensureColumn('self_analysis_results', 'analysis_run_id', 'TEXT');
  await ensureColumn('review_decisions', 'analysis_run_id', 'TEXT');
  await ensureColumn('review_decisions', 'cluster_key', 'TEXT');
  await ensureIndex('idx_runs_active', 'analysis_runs', 'tender_id, kind, superseded_at');
  await ensureIndex('idx_draft_issues_run', 'draft_issues', 'tender_id, analysis_run_id');
  await ensureIndex('idx_issue_reviews_run', 'issue_reviews', 'tender_id, analysis_run_id');
  await ensureIndex('idx_issue_clusters_run', 'issue_clusters', 'tender_id, analysis_run_id');
  await ensureIndex('idx_self_analysis_run', 'self_analysis_results', 'tender_id, analysis_run_id');
  await ensureIndex('idx_decisions_run', 'review_decisions', 'analysis_run_id');

  // --- Модель материальности замечания (impact × evidence → verdict) ----------
  //
  // Публикацию замечания решают impact_level (насколько дорого ГП) и
  // evidence_level (насколько подтверждено), а НЕ criticality/confidence —
  // см. services/review/materiality.js. Колонки добавляются во все три слоя
  // конвейера: draft_issues (мнение агентов), issue_reviews (авторитетный
  // вердикт critic), issue_clusters (свёртка на объект рецензии).
  for (const table of ['draft_issues', 'issue_reviews']) {
    // eslint-disable-next-line no-await-in-loop
    await ensureColumn(table, 'impact_level', 'TEXT');
    // eslint-disable-next-line no-await-in-loop
    await ensureColumn(table, 'evidence_level', 'TEXT');
    // eslint-disable-next-line no-await-in-loop
    await ensureColumn(table, 'verdict', 'TEXT');
    // eslint-disable-next-line no-await-in-loop
    await ensureColumn(table, 'impact_dimensions', 'TEXT');
    // eslint-disable-next-line no-await-in-loop
    await ensureColumn(table, 'publication_reason', 'TEXT');
    // eslint-disable-next-line no-await-in-loop
    await ensureColumn(table, 'suppression_reason', 'TEXT');
    // eslint-disable-next-line no-await-in-loop
    await ensureColumn(table, 'required_action', 'TEXT');
  }
  await ensureColumn('issue_clusters', 'verdict', 'TEXT');
  await ensureColumn('issue_clusters', 'overall_impact_level', 'TEXT');
  await ensureColumn('issue_clusters', 'overall_evidence_level', 'TEXT');
  await ensureColumn('issue_clusters', 'impact_dimensions', 'TEXT');
  await ensureColumn('issue_clusters', 'publication_reason', 'TEXT');
  await ensureColumn('issue_clusters', 'suppression_reason', 'TEXT');
  await ensureColumn('issue_clusters', 'required_action', 'TEXT');
  await ensureIndex('idx_issue_reviews_verdict', 'issue_reviews', 'tender_id, analysis_run_id, verdict');
  await ensureIndex('idx_issue_clusters_verdict', 'issue_clusters', 'tender_id, analysis_run_id, verdict');
  await backfillMateriality();

  // Precision-критик (services/critic/precision/): исход проверки, кто его принял
  // и полная карта из 9 измерений. Старые строки остаются с NULL — это честно:
  // их никакой критик не проверял, и выдумывать ему решение задним числом нельзя.
  // Вердикт таких строк уже перенесён backfillMateriality, поэтому из выборок
  // они не выпадают.
  await ensureColumn('issue_reviews', 'critic_outcome', 'TEXT');
  await ensureColumn('issue_reviews', 'critic_source', 'TEXT');
  await ensureColumn('issue_reviews', 'critic_assessment', 'TEXT');
  await ensureIndex('idx_issue_reviews_outcome', 'issue_reviews', 'tender_id, analysis_run_id, critic_outcome');

  // --- Повторяющееся требование: одно замечание, несколько вхождений ---------
  //
  // Ярус 2 кластеризации (clustering/topicModel.js) сводит однотипную обязанность
  // ГП из разных пунктов ТЗ в ОДИН кластер. Вхождения хранятся при кластере,
  // потому что после активации снимок неизменяем: пересчитывать их на чтении
  // из draft_issues значило бы показывать не то, что было решено инженером.
  await ensureColumn('issue_clusters', 'occurrence_count', 'INTEGER');
  await ensureColumn('issue_clusters', 'evidence_fragments', 'TEXT');
  await ensureColumn('issue_clusters', 'affected_sections', 'TEXT');
  await ensureColumn('issue_clusters', 'representative_fragment', 'TEXT');
  await ensureColumn('issue_clusters', 'topic_key', 'TEXT');
  await ensureColumn('issue_clusters', 'work_object', 'TEXT');
  // Старые кластеры собирались только по месту — у них ровно одно вхождение.
  // Задним числом их не пересобираем (снимок неизменяем), но счётчик обязан
  // быть честным: NULL в UI выглядел бы как «мест нет».
  await db.exec('UPDATE issue_clusters SET occurrence_count = 1 WHERE occurrence_count IS NULL;');

  // --- Части ТЗ: КЭШ отдельно, ИСТОРИЯ ВЫПОЛНЕНИЯ отдельно -------------------
  //
  // Раньше analysis_segments была одной строкой на (тендер, стадия, часть) и
  // играла обе роли сразу: и кэш результата, и «статус части». Повтор стадии
  // перезаписывал строку, поэтому история прошлого прогона (где именно он упал)
  // исчезала, а analysis_run_id показывал лишь ПОСЛЕДНЕГО писателя.
  // Теперь analysis_segments — кэш, скоупленный РЕВИЗИЕЙ документов, а история
  // выполнения живёт в analysis_run_segments (UNIQUE (analysis_run_id,
  // segment_index), пишет только прогон-владелец, пока он running).
  await ensureColumn('analysis_segments', 'config_version', 'TEXT');
  await ensureColumn('analysis_segments', 'computed_run_id', 'TEXT');
  if (await columnExists('analysis_segments', 'analysis_run_id')) {
    // Кто посчитал результат — переносим в справочное поле кэша (истории из этой
    // колонки не восстановить: она хранила лишь последнего писателя).
    await db.queryRun(
      'UPDATE analysis_segments SET computed_run_id = analysis_run_id WHERE computed_run_id IS NULL',
    );
  }
  // Кэш без ревизии не адресуем (переиспользовать его для другой версии ТЗ
  // нельзя) — такие строки удаляем: это кэш, а не история.
  await db.queryRun('DELETE FROM analysis_segments WHERE document_revision_id IS NULL');
  await db.exec("ALTER TABLE analysis_segments ALTER COLUMN document_revision_id SET DEFAULT '';");
  await db.exec('ALTER TABLE analysis_segments ALTER COLUMN document_revision_id SET NOT NULL;');
  // Статус кэша теперь двузначный: есть сохранённый результат или нет.
  // Прежние 'running'/'failed' — это состояния ВЫПОЛНЕНИЯ, они уехали в историю.
  await db.queryRun("UPDATE analysis_segments SET status = 'pending' WHERE status NOT IN ('pending', 'completed')");
  // Ключ кэша: прежний (тендер, стадия, часть) снимаем, новый включает ревизию.
  await db.exec(
    'ALTER TABLE analysis_segments DROP CONSTRAINT IF EXISTS analysis_segments_tender_id_analysis_stage_segment_index_key;',
  );
  await execTolerant(
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_segments_cache
       ON analysis_segments(tender_id, analysis_stage, document_revision_id, segment_index);`,
  );
  // Кросс-ревизионное переиспользование частей (селективный пересчёт после
  // согласованной версии): поиск completed-части по input_hash.
  await ensureIndex('idx_segments_hash', 'analysis_segments', 'tender_id, analysis_stage, input_hash');
  // Колонки состояния выполнения в кэше больше не нужны — их роль забрала
  // analysis_run_segments (там они неизменяемы и привязаны к своему прогону).
  for (const col of ['analysis_run_id', 'attempts', 'error', 'started_at', 'finished_at']) {
    // eslint-disable-next-line no-await-in-loop
    if (await columnExists('analysis_segments', col)) {
      // eslint-disable-next-line no-await-in-loop
      await db.exec(`ALTER TABLE analysis_segments DROP COLUMN IF EXISTS ${col};`);
      console.log(`[migrate] analysis_segments.${col} dropped (уехало в analysis_run_segments)`);
    }
  }

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

  // Backfill снимков анализа — отдельно по каждому тендеру и каждой стадии.
  // Строго ПОСЛЕ перенумерации стадий: иначе синтетические прогоны получили бы id
  // и scope указателя по старому номеру стадии, а сам номер уехал бы на +1.
  await backfillAnalysisSnapshots();

  // --- Безопасность: изоляция тенантов и происхождение файлов ---------------
  // tenders.tenant_id — ключ изоляции. Существующие тендеры уходят в тенант по
  // умолчанию (SECURITY_DEFAULT_TENANT, обычно 'default'): до появления
  // мультитенантности вся база принадлежала одной организации.
  const tenantAdded = await ensureColumn('tenders', 'tenant_id', 'TEXT');
  const defaultTenant = (process.env.SECURITY_DEFAULT_TENANT || 'default').trim() || 'default';
  await db.queryRun(
    `INSERT INTO tenants (id, name, status, created_at)
     VALUES (?, ?, 'active', to_char((now() at time zone 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
     ON CONFLICT (id) DO NOTHING`,
    defaultTenant,
    defaultTenant === 'default' ? 'Организация по умолчанию' : defaultTenant,
  );
  const orphanTenders = await db.queryOne('SELECT COUNT(*) AS c FROM tenders WHERE tenant_id IS NULL');
  if (Number(orphanTenders && orphanTenders.c) > 0) {
    await db.queryRun('UPDATE tenders SET tenant_id = ? WHERE tenant_id IS NULL', defaultTenant);
    console.log(`[migrate] tenders.tenant_id backfilled → '${defaultTenant}' (${orphanTenders.c})`);
  }
  // DEFAULT + NOT NULL: тендер БЕЗ тенанта невозможен на уровне схемы. Иначе
  // любой путь вставки в обход контроллера (сид, служебный скрипт, тест)
  // создавал бы «ничью» строку, которую проверка изоляции вынуждена была бы
  // трактовать по умолчанию. Внешнего ключа на tenants сознательно нет: тенант
  // заводит провайдер токенов, портал не должен блокировать работу до ручного
  // провижининга организации.
  await db.exec(`ALTER TABLE tenders ALTER COLUMN tenant_id SET DEFAULT '${defaultTenant.replace(/'/g, "''")}';`);
  await db.exec('ALTER TABLE tenders ALTER COLUMN tenant_id SET NOT NULL;');
  if (tenantAdded) await ensureIndex('idx_tenders_tenant', 'tenders', 'tenant_id');

  // Происхождение загруженного файла: хэш (что именно лежит на диске), размер и
  // вердикт антивируса — чтобы по журналу можно было доказать, ЧТО приняли.
  await ensureColumn('documents', 'sha256', 'TEXT');
  await ensureColumn('documents', 'size_bytes', 'INTEGER');
  await ensureColumn('documents', 'av_status', 'TEXT');
  await ensureColumn('documents', 'uploaded_by', 'TEXT');
  await ensureIndex('idx_documents_sha256', 'documents', 'sha256');

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

  // Манифест тендерного пакета: у каждого документа — редакция, статус
  // актуальности, дата, приоритет при противоречии, применимость (корпус/раздел)
  // и ссылка на заменённый документ. Выбор входа анализа идёт по этим полям
  // (services/documents/manifestModel.js), а не «последний загруженный».
  await ensureColumn('documents', 'revision_label', 'TEXT');
  await ensureColumn('documents', 'actuality_status', "TEXT DEFAULT 'actual'");
  await ensureColumn('documents', 'doc_date', 'TEXT');
  await ensureColumn('documents', 'conflict_priority', 'INTEGER');
  await ensureColumn('documents', 'applicability', 'TEXT');
  await ensureColumn('documents', 'supersedes_document_id', 'TEXT');

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

// backfillMateriality экспортируется для integration-теста переноса старых
// данных: он должен проверяться отдельно от полного runMigration.
module.exports = { runMigration, backfillMateriality };
