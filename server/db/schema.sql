-- TZ-Opti: схема БД (SQLite)
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
  doc_type            TEXT NOT NULL,    -- 'tz' | 'pd_rd' | 'vor' | 'checklist' | 'company_conditions' | 'risks' | 'object_info' | 'qa' | 'other'
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

CREATE TABLE IF NOT EXISTS additional_object_info (
  id                  TEXT PRIMARY KEY,
  tender_id           TEXT NOT NULL UNIQUE,
  tender_type         TEXT,
  package_scope       TEXT,
  terms               TEXT,
  staging             TEXT,
  blocks_sections     TEXT,
  site_constraints    TEXT,
  special_conditions  TEXT,
  comment             TEXT,
  FOREIGN KEY (tender_id) REFERENCES tenders(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS qa_entries (
  id                 TEXT PRIMARY KEY,
  tender_id          TEXT NOT NULL,
  source_file_path   TEXT,
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
  stage        INTEGER NOT NULL,        -- 1..4
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  status       TEXT DEFAULT 'completed',-- 'running' | 'completed' | 'failed'
  summary      TEXT,
  FOREIGN KEY (tender_id) REFERENCES tenders(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_runs_tender_stage ON analysis_runs(tender_id, stage);

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
  review_status        TEXT DEFAULT 'pending', -- 'pending' | 'accepted' | 'rejected' | 'edited'
  edited_redaction     TEXT,
  manually_edited      INTEGER DEFAULT 0,
  selected_for_export  INTEGER DEFAULT 1,
  FOREIGN KEY (tender_id) REFERENCES tenders(id) ON DELETE CASCADE,
  FOREIGN KEY (analysis_run_id) REFERENCES analysis_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (source_document_id) REFERENCES documents(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_issues_tender_stage ON issues(tender_id, analysis_stage);

CREATE TABLE IF NOT EXISTS review_decisions (
  id                  TEXT PRIMARY KEY,
  issue_id            TEXT NOT NULL,
  decision            TEXT NOT NULL,   -- 'accept' | 'reject' | 'edit' | 'delete' | 'remove_from_scope'
  edited_redaction    TEXT,
  final_comment       TEXT,
  decided_at          TEXT NOT NULL,
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_decisions_issue ON review_decisions(issue_id);

CREATE TABLE IF NOT EXISTS tz_excluded_ranges (
  id                   TEXT PRIMARY KEY,
  tender_id            TEXT NOT NULL,
  source_document_id   TEXT,
  paragraph_index      INTEGER,
  char_start           INTEGER,
  char_end             INTEGER,
  after_stage          INTEGER NOT NULL,
  source_issue_id      TEXT,
  created_at           TEXT NOT NULL,
  FOREIGN KEY (tender_id) REFERENCES tenders(id) ON DELETE CASCADE,
  FOREIGN KEY (source_document_id) REFERENCES documents(id) ON DELETE SET NULL,
  FOREIGN KEY (source_issue_id) REFERENCES issues(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_excluded_tender ON tz_excluded_ranges(tender_id);

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
  section    TEXT NOT NULL,        -- 'checklist' | 'conditions' | 'risks' | 'object_info' | 'qa' | 'documents'
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
  finished_at    TEXT,
  FOREIGN KEY (tender_id) REFERENCES tenders(id) ON DELETE CASCADE
);
