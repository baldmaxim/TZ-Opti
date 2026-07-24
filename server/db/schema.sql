-- TZ-Opti: схема БД (PostgreSQL / Supabase; применяется через db/migrate.js)
-- ID = UUID v4 (TEXT). Даты — ISO 8601 (TEXT).

CREATE TABLE IF NOT EXISTS tenders (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  customer     TEXT,
  type         TEXT,            -- 'general_contract' | 'shell' | 'monolith' | 'masonry' | 'waterproofing' | 'other'
  stage        TEXT,            -- стадия проекта (П / РД и т.п.)
  deadline     TEXT,
  owner        TEXT,
  status       TEXT DEFAULT 'draft',  -- 'draft' | 'in_progress' | 'submitted' | 'won' | 'lost' | 'archived'
  description  TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id                  TEXT PRIMARY KEY,
  tender_id           TEXT NOT NULL,
  doc_type            TEXT NOT NULL,    -- 'tz' | 'pd_rd' | 'vor' | 'checklist' | 'company_conditions' | 'risks' | 'qa' | 'other'
  name                TEXT NOT NULL,
  file_path           TEXT NOT NULL,
  mime_type           TEXT,
  version             TEXT DEFAULT '1',
  uploaded_at         TEXT NOT NULL,
  comment             TEXT,
  extracted_text      TEXT,
  processing_status   TEXT DEFAULT 'pending', -- 'pending' | 'extracted' | 'failed'
  FOREIGN KEY (tender_id) REFERENCES tenders(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_documents_tender ON documents(tender_id);

CREATE TABLE IF NOT EXISTS work_checklist_items (
  id                TEXT PRIMARY KEY,
  tender_id         TEXT NOT NULL,
  section           TEXT,
  work_name         TEXT NOT NULL,
  in_tz             INTEGER DEFAULT 0,
  in_pd_rd          INTEGER DEFAULT 0,
  in_vor            INTEGER DEFAULT 0,
  in_calc           INTEGER DEFAULT 0,
  in_kp             INTEGER DEFAULT 0,
  in_contract       INTEGER DEFAULT 0,
  affects_schedule  INTEGER DEFAULT 0,
  decision          TEXT,
  comment           TEXT,
  FOREIGN KEY (tender_id) REFERENCES tenders(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_checklist_tender ON work_checklist_items(tender_id);

CREATE TABLE IF NOT EXISTS company_conditions (
  id           TEXT PRIMARY KEY,
  tender_id    TEXT NOT NULL,
  category     TEXT,
  condition    TEXT NOT NULL,
  criticality  TEXT DEFAULT 'medium',  -- 'low' | 'medium' | 'high' | 'critical'
  comment      TEXT,
  FOREIGN KEY (tender_id) REFERENCES tenders(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_conditions_tender ON company_conditions(tender_id);

CREATE TABLE IF NOT EXISTS risk_templates (
  id              TEXT PRIMARY KEY,
  tender_id       TEXT,             -- NULL для глобальных
  category        TEXT,
  risk_text       TEXT NOT NULL,
  recommendation  TEXT,
  criticality     TEXT DEFAULT 'medium',
  is_global       INTEGER DEFAULT 0,
  FOREIGN KEY (tender_id) REFERENCES tenders(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_risks_tender ON risk_templates(tender_id);

CREATE TABLE IF NOT EXISTS qa_entries (
  id                 TEXT PRIMARY KEY,
  tender_id          TEXT NOT NULL,
  source_file_path   TEXT,
  section            TEXT,
  sent_at            TEXT,
  answer_at          TEXT,
  round_label        TEXT,
  tz_clause          TEXT,                 -- ссылка/название пункта ТЗ
  tz_reflected       INTEGER DEFAULT 0,    -- 0/1: решение отражено в ТЗ
  tz_contradicts     INTEGER DEFAULT 0,    -- 0/1: ТЗ противоречит решению
  affects_calc       INTEGER DEFAULT 0,    -- влияет на расчёт
  affects_kp         INTEGER DEFAULT 0,    -- влияет на КП
  affects_contract   INTEGER DEFAULT 0,    -- влияет на договор
  affects_schedule   INTEGER DEFAULT 0,    -- влияет на график
  question           TEXT,
  answer             TEXT,
  accepted_decision  TEXT,
  order_idx          INTEGER DEFAULT 0,
  imported_at        TEXT NOT NULL,
  FOREIGN KEY (tender_id) REFERENCES tenders(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_qa_tender ON qa_entries(tender_id);

CREATE TABLE IF NOT EXISTS characteristics (
  id                  TEXT PRIMARY KEY,
  tender_id           TEXT NOT NULL,
  name                TEXT NOT NULL,
  value               TEXT,
  source              TEXT,
  comment             TEXT,
  derived_from_qa_id  TEXT,
  FOREIGN KEY (tender_id) REFERENCES tenders(id) ON DELETE CASCADE,
  FOREIGN KEY (derived_from_qa_id) REFERENCES qa_entries(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_characteristics_tender ON characteristics(tender_id);

CREATE TABLE IF NOT EXISTS analysis_runs (
  id           TEXT PRIMARY KEY,
  tender_id    TEXT NOT NULL,
  stage        INTEGER,                 -- 1..5 для kind='stage'; NULL для 'pipeline'
  kind         TEXT DEFAULT 'stage',    -- 'stage' (issues+signals) | 'pipeline' (draft/clusters/self)
  documents_revision_id TEXT,           -- ревизия набора документов тендера на момент прогона
  config_version        TEXT,           -- версия конфигурации анализа (варианты промтов + модель)
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  status       TEXT DEFAULT 'completed',-- 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled'
  summary      TEXT,
  superseded_at TEXT,                   -- NULL = актуальный; дата = архивный (неизменяемый) снимок
  FOREIGN KEY (tender_id) REFERENCES tenders(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_runs_tender_stage ON analysis_runs(tender_id, stage);
-- idx_runs_active (по kind/superseded_at) создаётся в migrate.js ПОСЛЕ ensureColumn:
-- на существующих БД CREATE TABLE IF NOT EXISTS не добавляет новые столбцы, а
-- schema.sql применяется РАНЬШЕ ensureColumn — индекс по новому столбцу упал бы.

-- Указатель актуального прогона для комбинации (тендер + scope + ревизия
-- документов + версия конфигурации). scope: 'stage:1'..'stage:5' | 'pipeline'.
-- Одна строка на (tender_id, scope) — чтения берут analysis_run_id отсюда.
CREATE TABLE IF NOT EXISTS analysis_active_runs (
  tender_id             TEXT NOT NULL,
  scope                 TEXT NOT NULL,   -- 'stage:1'..'stage:5' | 'pipeline'
  documents_revision_id TEXT,
  config_version        TEXT,
  analysis_run_id       TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  PRIMARY KEY (tender_id, scope),
  FOREIGN KEY (tender_id) REFERENCES tenders(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS issues (
  id                   TEXT PRIMARY KEY,
  tender_id            TEXT NOT NULL,
  analysis_run_id      TEXT,
  analysis_stage       INTEGER NOT NULL,
  source_document_id   TEXT,
  source_clause        TEXT,
  source_fragment      TEXT,
  paragraph_index      INTEGER,
  char_start           INTEGER,
  char_end             INTEGER,
  problem_type         TEXT,
  risk_category        TEXT,
  criticality          TEXT DEFAULT 'medium',
  price_impact         TEXT,
  schedule_impact      TEXT,
  basis                TEXT,
  suggested_action     TEXT,         -- 'comment' | 'replace' | 'delete' | 'remove_from_scope' | 'clarify' | 'limit_scope' | 'assumption'
  suggested_redaction  TEXT,
  review_comment       TEXT,
  confidence           REAL DEFAULT 0.6,
  section_path         TEXT,         -- путь заголовков из .md ТЗ (например: "1. Введение › 1.2 Объём работ")
  review_status        TEXT DEFAULT 'pending', -- 'pending' | 'accepted' | 'rejected' | 'edited'
  edited_redaction     TEXT,
  manually_edited      INTEGER DEFAULT 0,
  selected_for_export  INTEGER DEFAULT 1,
  FOREIGN KEY (tender_id) REFERENCES tenders(id) ON DELETE CASCADE,
  FOREIGN KEY (analysis_run_id) REFERENCES analysis_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (source_document_id) REFERENCES documents(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_issues_tender_stage ON issues(tender_id, analysis_stage);

-- Слой сигналов (первый шаг новой архитектуры анализа:
--   входные данные -> signals -> единый анализатор -> critic -> clustering -> ...).
-- Параллельная запись: стадии 1..4 дополнительно эмитят сигналы рядом с issues,
-- НЕ меняя issue/review/export пайплайн. Источник — находки стадий.
CREATE TABLE IF NOT EXISTS analysis_signals (
  id                   TEXT PRIMARY KEY,
  tender_id            TEXT NOT NULL,
  analysis_run_id      TEXT,
  analysis_stage       INTEGER,
  signal_type          TEXT NOT NULL,    -- 'coverage' | 'decision' | 'condition' | 'risk'
  source_entity_type   TEXT,             -- что породило сигнал (пока 'issue')
  source_entity_id     TEXT,             -- id порождающей сущности (id issue)
  tz_clause            TEXT,             -- путь заголовков / пункт ТЗ
  source_fragment      TEXT,             -- дословный фрагмент ТЗ
  signal_payload_json  TEXT,             -- JSON с деталями находки
  weight               REAL DEFAULT 0.6, -- значимость 0..1 (берётся из confidence)
  created_at           TEXT NOT NULL,
  FOREIGN KEY (tender_id) REFERENCES tenders(id) ON DELETE CASCADE,
  FOREIGN KEY (analysis_run_id) REFERENCES analysis_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_signals_tender_type ON analysis_signals(tender_id, signal_type);

-- Единый анализатор ТЗ (второй шаг новой архитектуры, поверх слоя signals).
-- Сводит совокупность signals одного места ТЗ в один draft_issue. Это
-- ПАРАЛЛЕЛЬНЫЙ слой — не заменяет issues/review/export.
CREATE TABLE IF NOT EXISTS draft_issues (
  id                      TEXT PRIMARY KEY,
  tender_id               TEXT NOT NULL,
  analysis_run_id         TEXT,             -- pipeline-прогон (снимок), которому принадлежит строка
  tz_clause               TEXT,             -- пункт/путь заголовков ТЗ
  source_fragment         TEXT,             -- дословный фрагмент ТЗ
  problem_type            TEXT,
  category                TEXT,             -- сводный signal_type(ы) группы
  basis                   TEXT,             -- краткое основание
  suggested_action        TEXT,
  suggested_redaction     TEXT,
  review_comment          TEXT,
  confidence              REAL DEFAULT 0.6,
  created_from_signal_ids TEXT,             -- JSON-массив id сигналов-источников
  paragraph_index         INTEGER,          -- для стабильного порядка/дебага
  created_at              TEXT NOT NULL,
  FOREIGN KEY (tender_id) REFERENCES tenders(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_draft_issues_tender ON draft_issues(tender_id);
-- idx_draft_issues_run (по analysis_run_id) создаётся в migrate.js после ensureColumn.

-- Слой critic (третий шаг новой архитектуры, поверх draft_issues).
-- Оценивает значимость каждого draft_issue ДЛЯ ГЕНПОДРЯДЧИКА и решает, показывать
-- ли его инженеру в основном потоке. Малозначимые НЕ удаляются — только
-- show_to_engineer=0 (скрыты по умолчанию). ПАРАЛЛЕЛЬНЫЙ слой.
-- draft_issue_id каскадно удаляется при пересборке draft_issues → critic
-- нужно перезапускать после unified/build.
CREATE TABLE IF NOT EXISTS issue_reviews (
  id                     TEXT PRIMARY KEY,
  tender_id              TEXT NOT NULL,      -- денормализация: выборки/идемпотентность по тендеру
  analysis_run_id        TEXT,               -- pipeline-прогон (снимок), которому принадлежит строка
  draft_issue_id         TEXT NOT NULL,
  business_impact        TEXT,               -- общий уровень: none|low|medium|high
  price_impact           TEXT,               -- расчёт / КП / приёмка-оплата / объём
  schedule_impact        TEXT,               -- сроки / график
  contract_impact        TEXT,               -- договор / существенные условия
  responsibility_impact  TEXT,               -- обязанности / ответственность / гарантия
  display_priority       TEXT,               -- critical|high|medium|low
  show_to_engineer       INTEGER DEFAULT 1,  -- 1=показывать, 0=хранить, но скрывать по умолчанию
  critic_comment         TEXT,               -- человекочитаемое объяснение вердикта
  criteria_json          TEXT,               -- JSON сработавших критериев (прозрачность/дебаг)
  score                  REAL,               -- числовой суммарный балл (дебаг/тай-брейк)
  created_at             TEXT NOT NULL,
  FOREIGN KEY (tender_id) REFERENCES tenders(id) ON DELETE CASCADE,
  FOREIGN KEY (draft_issue_id) REFERENCES draft_issues(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_issue_reviews_tender ON issue_reviews(tender_id);
-- idx_issue_reviews_run (по analysis_run_id) создаётся в migrate.js после ensureColumn.

-- Слой clustering (четвёртый шаг новой архитектуры, поверх draft_issues + issue_reviews).
-- Сводит похожие замечания по ОДНОМУ месту ТЗ (tz_clause/фрагмент) И близкие по смыслу
-- (доминирующее измерение значимости + пересекающееся действие) в один кластер. Разные по
-- смыслу проблемы в одном пункте (открытый объём ≠ риск оплаты) остаются РАЗНЫМИ кластерами
-- — у каждого кластера свои cluster_items (исходные draft_issues), смысл не теряется.
CREATE TABLE IF NOT EXISTS issue_clusters (
  id                     TEXT PRIMARY KEY,
  tender_id              TEXT NOT NULL,
  analysis_run_id        TEXT,               -- pipeline-прогон (снимок), которому принадлежит кластер
  tz_clause              TEXT,               -- пункт/путь заголовков ТЗ (общий для кластера)
  cluster_title          TEXT,              -- краткий заголовок проблемы кластера
  merged_basis           TEXT,              -- объединённые основания разных стадий (по пунктам)
  merged_recommendation  TEXT,              -- объединённая рекомендация/действие
  overall_criticality    TEXT,              -- critical|high|medium|low (макс. по элементам)
  show_to_engineer       INTEGER DEFAULT 1, -- 1=показывать (любой элемент значим), 0=скрыт
  final_problem_type     TEXT,              -- problem_type первичного (наиболее значимого) элемента
  -- доп. прозрачность (сверх спеки):
  semantic_bucket        TEXT,              -- ключ смысловой группы (домен значимости + действие)
  cluster_key            TEXT,              -- стабильная сигнатура (placeKey::semanticBucket) — основа детерминированного id
  item_count             INTEGER,           -- число draft_issues в кластере
  paragraph_index        INTEGER,           -- для стабильного порядка/дебага
  created_at             TEXT NOT NULL,
  FOREIGN KEY (tender_id) REFERENCES tenders(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_issue_clusters_tender ON issue_clusters(tender_id);
-- idx_issue_clusters_run (по analysis_run_id) создаётся в migrate.js после ensureColumn.

CREATE TABLE IF NOT EXISTS issue_cluster_items (
  id                  TEXT PRIMARY KEY,
  cluster_id          TEXT NOT NULL,
  draft_issue_id      TEXT NOT NULL,
  item_role           TEXT,            -- primary|related (подпункт внутри кластера, смысл сохранён)
  created_at          TEXT NOT NULL,
  FOREIGN KEY (cluster_id) REFERENCES issue_clusters(id) ON DELETE CASCADE,
  FOREIGN KEY (draft_issue_id) REFERENCES draft_issues(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cluster_items_cluster ON issue_cluster_items(cluster_id);

-- Слой self-analysis (пятый шаг новой архитектуры, поверх issue_clusters + issue_reviews + signals).
-- НОВАЯ роль Стадии 5 «Самоанализ ТЗ»: не второй хаотичный поток issues, а слой
-- QUALITY-CONTROL / COMPLETENESS-CHECK над уже собранным итогом. Проверяет не текст
-- ТЗ «с нуля», а готовые кластеры + исходный ТЗ и отвечает на 4 вопроса:
--   что могли пропустить · где кластеры слабые · где противоречие между кластерами ·
--   где усилить basis / review_comment / suggested_redaction.
-- НЕ дублирует Стадию 4 (та ищет типовые риски в тексте) — здесь оценка качества сборки.
-- ПАРАЛЛЕЛЬНЫЙ слой: не пишет в issues/review/export. cluster_id каскадно удаляется
-- при пересборке кластеров → self-analysis нужно перезапускать после clustering/build.
CREATE TABLE IF NOT EXISTS self_analysis_results (
  id                     TEXT PRIMARY KEY,
  tender_id              TEXT NOT NULL,
  analysis_run_id        TEXT,               -- pipeline-прогон (снимок), которому принадлежит замечание
  cluster_id             TEXT,               -- кластер-адресат замечания (NULL = про весь ТЗ / пропуск)
  finding_type           TEXT NOT NULL,      -- missed_coverage|weak_cluster|cluster_contradiction|needs_enrichment
  comment                TEXT,               -- что именно не так (человекочитаемо)
  suggested_improvement  TEXT,               -- как улучшить итог
  confidence             REAL DEFAULT 0.6,   -- уверенность 0..1
  -- доп. прозрачность (сверх минимума спеки):
  source                 TEXT,               -- heuristic|llm (чем порождено замечание)
  related_cluster_id     TEXT,               -- для cluster_contradiction — второй кластер пары
  created_at             TEXT NOT NULL,
  FOREIGN KEY (tender_id) REFERENCES tenders(id) ON DELETE CASCADE,
  FOREIGN KEY (cluster_id) REFERENCES issue_clusters(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_self_analysis_tender ON self_analysis_results(tender_id);
-- idx_self_analysis_run (по analysis_run_id) создаётся в migrate.js после ensureColumn.

-- Решение инженера по находке. Этап 6: основным адресатом стало issue_clusters
-- (cluster_id), issue_id оставлен как legacy/back-compat и больше НЕ NOT NULL.
-- ОДНО из (issue_id, cluster_id) заполнено. cluster_id — БЕЗ FK-constraint:
-- кластеры пересобираются (DELETE+INSERT), а решения должны переживать пересборку;
-- их id детерминирован (clusteringService.clusterId), поэтому ссылка стабильна.
CREATE TABLE IF NOT EXISTS review_decisions (
  id                  TEXT PRIMARY KEY,
  issue_id            TEXT,            -- legacy: находка стадии (nullable с этапа 6)
  cluster_id          TEXT,            -- new primary: issue_clusters.id (run-scoped, без FK)
  analysis_run_id     TEXT,            -- pipeline-прогон, к кластерам которого относится решение
  cluster_key         TEXT,            -- стабильная сигнатура кластера (для явного переноса между прогонами)
  decision            TEXT NOT NULL,   -- 'accept' | 'reject' | 'edit' | 'delete' | 'remove_from_scope'
  edited_redaction    TEXT,
  final_comment       TEXT,
  target_text         TEXT,            -- выбранная инженером ПОДЧАСТЬ фрагмента (NULL = весь фрагмент)
  decided_at          TEXT NOT NULL,
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_decisions_issue ON review_decisions(issue_id);
-- idx_decisions_run (по analysis_run_id) создаётся в migrate.js после ensureColumn.
-- idx_decisions_cluster создаётся в migrate.js (ensureIndex) ПОСЛЕ ensureColumn(cluster_id),
-- т.к. на существующих БД CREATE TABLE IF NOT EXISTS не добавляет новый столбец.

CREATE TABLE IF NOT EXISTS tz_excluded_ranges (
  id                   TEXT PRIMARY KEY,
  tender_id            TEXT NOT NULL,
  source_document_id   TEXT,
  document_revision_id TEXT,             -- ревизия ТЗ, против которой посчитано исключение
  node_id              TEXT,             -- стабильный идентификатор узла (абзаца) в ТЗ
  source_text_hash     TEXT,             -- хэш исходного текста исключаемого фрагмента
  paragraph_index      INTEGER,
  char_start           INTEGER,
  char_end             INTEGER,
  after_stage          INTEGER NOT NULL,
  source_issue_id      TEXT,
  stale                INTEGER DEFAULT 0, -- 1 = исключение из другой ревизии, автоматически НЕ применяется
  needs_confirmation   INTEGER DEFAULT 0, -- 1 = требует подтверждения инженером после смены версии ТЗ
  created_at           TEXT NOT NULL,
  FOREIGN KEY (tender_id) REFERENCES tenders(id) ON DELETE CASCADE,
  FOREIGN KEY (source_document_id) REFERENCES documents(id) ON DELETE SET NULL,
  FOREIGN KEY (source_issue_id) REFERENCES issues(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_excluded_tender ON tz_excluded_ranges(tender_id);

CREATE TABLE IF NOT EXISTS tender_custom_risks (
  id          TEXT PRIMARY KEY,
  tender_id   TEXT NOT NULL,
  category    TEXT,
  risk_text   TEXT NOT NULL,
  triggers    TEXT,                  -- JSON-массив фраз
  criticality TEXT DEFAULT 'medium',
  created_at  TEXT NOT NULL,
  FOREIGN KEY (tender_id) REFERENCES tenders(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tender_risk_state (
  tender_id   TEXT NOT NULL,
  risk_key    TEXT NOT NULL,        -- ключ из standardRisks.js
  applies     INTEGER,              -- 1=Да, 0=Нет, NULL=не указано (использовать auto-default)
  comment     TEXT,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (tender_id, risk_key),
  FOREIGN KEY (tender_id) REFERENCES tenders(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tender_setup_params (
  tender_id        TEXT PRIMARY KEY,
  contract_kind    TEXT,                 -- 'gen' | 'shell'
  escalation       TEXT,                 -- значение из PARAMS_SCHEMA[kind].escalation.options
  advance          TEXT,                 -- только для gen; для shell — NULL
  build_months     INTEGER,
  transfer_months  INTEGER,
  kp_date          TEXT,                 -- ISO date (YYYY-MM-DD)
  updated_at       TEXT NOT NULL,
  FOREIGN KEY (tender_id) REFERENCES tenders(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS setup_locks (
  tender_id  TEXT NOT NULL,
  section    TEXT NOT NULL,        -- 'checklist' | 'conditions' | 'risks' | 'qa' | 'documents'
  locked_at  TEXT NOT NULL,
  PRIMARY KEY (tender_id, section),
  FOREIGN KEY (tender_id) REFERENCES tenders(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tender_stage_state (
  tender_id      TEXT PRIMARY KEY,
  current_stage  INTEGER DEFAULT 1,
  stage1_status  TEXT DEFAULT 'open',  -- 'open' | 'running' | 'reviewing' | 'finished'
  stage2_status  TEXT DEFAULT 'locked',
  stage3_status  TEXT DEFAULT 'locked',
  stage4_status  TEXT DEFAULT 'locked',
  stage5_status  TEXT DEFAULT 'locked',
  finished_at    TEXT,
  FOREIGN KEY (tender_id) REFERENCES tenders(id) ON DELETE CASCADE
);

-- ─── Устойчивая очередь фоновых задач (analysis_jobs / analysis_tasks) ────────
-- Заменяет прежнее хранение фоновых прогонов в памяти процесса (Set/Map):
-- прогресс, отмена, повторы и восстановление после рестарта живут в БД, поэтому
-- переживают падение сервера и работают на нескольких процессах-воркерах.
--
-- analysis_jobs — ЗАДАНИЕ (запрос инженера: «прогнать стадию N», «пересобрать
-- конвейер»). Единица идемпотентности, отмены и отображения в UI.
CREATE TABLE IF NOT EXISTS analysis_jobs (
  id                    TEXT PRIMARY KEY,
  tender_id             TEXT NOT NULL,
  job_type              TEXT NOT NULL,             -- 'stage_analysis' | 'pipeline'
  scope_key             TEXT NOT NULL,             -- 'stage:1'..'stage:5' | 'pipeline'
  idempotency_key       TEXT NOT NULL,             -- повторный запуск того же прогона не создаёт дубль
  lock_key              TEXT NOT NULL,             -- ключ pg advisory-lock (bigint строкой)
  documents_revision_id TEXT,
  config_version        TEXT,
  analysis_run_id       TEXT,                      -- снимок анализа, который собирает задание
  status                TEXT NOT NULL DEFAULT 'queued', -- queued|running|completed|failed|cancelled|interrupted
  cancel_requested      INTEGER DEFAULT 0,
  payload_json          TEXT,
  result_json           TEXT,
  error                 TEXT,
  progress_total        INTEGER DEFAULT 0,
  progress_done         INTEGER DEFAULT 0,
  created_by            TEXT,
  created_at            TEXT NOT NULL,
  started_at            TEXT,
  finished_at           TEXT,
  updated_at            TEXT NOT NULL,
  FOREIGN KEY (tender_id) REFERENCES tenders(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_jobs_tender ON analysis_jobs(tender_id, status);
CREATE INDEX IF NOT EXISTS idx_jobs_scope ON analysis_jobs(tender_id, scope_key, status);
-- Ключевой инвариант «без дублей»: на один ключ идемпотентности не может быть
-- двух ЖИВЫХ заданий. Гонку двух одновременных POST разрешает БД, а не приложение.
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_idem_active
  ON analysis_jobs(idempotency_key) WHERE status IN ('queued', 'running');

-- analysis_tasks — ЗАДАЧА (единица работы воркера: одна стадия / один шаг
-- конвейера). Здесь живут аренда (lease) + heartbeat, попытки, checkpoint.
-- Задачи задания упорядочены по seq: следующая стартует после завершения
-- предыдущих (always_run=1 — финализатор, стартует и после сбоя шага).
CREATE TABLE IF NOT EXISTS analysis_tasks (
  id               TEXT PRIMARY KEY,
  job_id           TEXT NOT NULL,
  tender_id        TEXT NOT NULL,
  task_key         TEXT NOT NULL,            -- уникален внутри задания
  task_type        TEXT NOT NULL,            -- обработчик: 'stage_analysis' | 'pipeline_begin' | ...
  seq              INTEGER NOT NULL DEFAULT 0,
  always_run       INTEGER DEFAULT 0,        -- 1 = выполнить даже после сбоя предыдущих
  status           TEXT NOT NULL DEFAULT 'queued', -- queued|running|completed|failed|cancelled|interrupted|skipped
  attempts         INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 3,
  priority         INTEGER NOT NULL DEFAULT 100,
  run_after        TEXT NOT NULL,            -- отложенный старт (backoff повторов)
  locked_by        TEXT,                     -- id воркера, взявшего задачу
  locked_at        TEXT,
  heartbeat_at     TEXT,
  lease_expires_at TEXT,                     -- аренда: истекла → воркер считается мёртвым
  progress_total   INTEGER DEFAULT 0,
  progress_done    INTEGER DEFAULT 0,
  checkpoint_json  TEXT,                     -- частичный результат: повтор продолжает с него
  payload_json     TEXT,
  result_json      TEXT,
  error            TEXT,
  created_at       TEXT NOT NULL,
  started_at       TEXT,
  finished_at      TEXT,
  updated_at       TEXT NOT NULL,
  UNIQUE (job_id, task_key),
  FOREIGN KEY (job_id) REFERENCES analysis_jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (tender_id) REFERENCES tenders(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tasks_claim ON analysis_tasks(status, run_after, priority, seq);
CREATE INDEX IF NOT EXISTS idx_tasks_job ON analysis_tasks(job_id, seq);
CREATE INDEX IF NOT EXISTS idx_tasks_lease ON analysis_tasks(status, lease_expires_at);
