'use strict';

// Реестр прогонов анализа (analysis runs) — ядро неизменяемых снимков.
//
// Каждый анализ = снимок с analysis_run_id. Два уровня (kind):
//   • 'stage'    — снимок одной стадии (issues + analysis_signals). scope 'stage:N'.
//   • 'pipeline' — снимок производных слоёв (draft_issues → issue_reviews →
//                  issue_clusters → self_analysis_results + review_decisions),
//                  собранный из АКТУАЛЬНЫХ stage-прогонов. scope 'pipeline'.
//
// Для комбинации (тендер + scope + ревизия документов + версия конфигурации)
// есть указатель актуального прогона — таблица analysis_active_runs. Чтения берут
// ТОЛЬКО прогоны из указателей (согласованный набор). Пересборка НЕ удаляет старые
// строки: создаёт новый прогон (beginRun), по успеху переводит указатель и
// архивирует прежний (activateRun, superseded_at). Инвариант: указатель всегда
// показывает на completed-прогон; провал повторного прогона не архивирует прежний.
//
// Решения инженера переносятся между прогонами ТОЛЬКО явно: listCarryOverProposals
// сопоставляет, confirmCarryOvers подтверждает. Авто-переноса нет.

const crypto = require('crypto');
const db = require('../../db/connection');
const { newId, nowIso } = require('../../utils/ids');
const { computeRevisionId } = require('../tzActiveTextService');

const SCOPE_PIPELINE = 'pipeline';
const stageScope = (stage) => `stage:${stage}`;

// --- Чистое ядро (детерминированное, офлайн-тесты) ---------------------------

function sha1(s) {
  return crypto.createHash('sha1').update(String(s == null ? '' : s)).digest('hex');
}

function norm(s) {
  return (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Ревизия НАБОРА документов тендера: детерминированный хэш по ревизиям всех
// документов (computeRevisionId у каждого), отсортированным для стабильности.
// Любая загрузка/изменение любого документа тендера меняет результат.
function computeDocumentsRevision(docs) {
  const revs = (docs || []).map((d) => computeRevisionId(d)).filter(Boolean).sort();
  if (!revs.length) return 'docs_empty';
  return `docs_${sha1(revs.join('|')).slice(0, 24)}`;
}

// Версия конфигурации анализа: то, что меняет смысл вывода при том же тексте —
// варианты промтов стадий + модель + температура. Из env (дефолты — как в
// stageNPrompts/openaiClient). Детерминирована.
const PROMPT_VARIANT_KEYS = [
  'STAGE1_PROMPT_VARIANT', 'STAGE2_PROMPT_VARIANT', 'STAGE3_PROMPT_VARIANT',
  'STAGE4_PROMPT_VARIANT', 'STAGE5_PROMPT_VARIANT',
];
function computeConfigVersion(env = {}) {
  const parts = PROMPT_VARIANT_KEYS.map((k) => `${k}=${env[k] || 'structural'}`);
  parts.push(`OPENAI_MODEL=${env.OPENAI_MODEL || 'gpt-4o'}`);
  parts.push(`TEMPERATURE=${env.OPENAI_TEMPERATURE || '0.2'}`);
  return `cfg_${sha1(parts.join(';')).slice(0, 16)}`;
}

// Run-scoped id кластера: включает runId, поэтому кластеры разных прогонов НЕ
// сталкиваются по id и решения прошлого прогона НЕ приклеиваются автоматически
// (перенос — только явный).
function clusterRunId(tenderId, runId, key) {
  return `clu_${sha1(`${tenderId}::${runId || ''}::${key}`).slice(0, 24)}`;
}

// Согласованный набор актуальных прогонов: id из указателей, чей прогон не
// архивирован (superseded_at пуст). Чтения берут только эти прогоны.
function selectActiveRunIds(runs, pointers) {
  const bySuperseded = new Map((runs || []).map((r) => [r.id, r.superseded_at]));
  const out = new Set();
  for (const p of pointers || []) {
    const id = p && p.analysis_run_id;
    if (!id) continue;
    const sup = bySuperseded.has(id) ? bySuperseded.get(id) : null;
    if (sup == null || sup === '') out.add(id);
  }
  return out;
}

// Сопоставление решений прошлого прогона с кластерами нового (для переноса).
// Для каждого решения лучший кластер: точное по cluster_key → по месту
// (tz_clause) → по тексту фрагмента. Ничего не подтверждает — только предлагает.
function matchDecisionsToClusters(oldDecisions, newClusters) {
  const byKey = new Map();
  const byClause = new Map();
  const byFrag = new Map();
  for (const c of newClusters || []) {
    if (c.cluster_key && !byKey.has(c.cluster_key)) byKey.set(c.cluster_key, c);
    const clause = norm(c.tz_clause);
    if (clause && !byClause.has(clause)) byClause.set(clause, c);
    const frag = norm(c.source_fragment);
    if (frag && !byFrag.has(frag)) byFrag.set(frag, c);
  }
  const proposals = [];
  for (const d of oldDecisions || []) {
    let cluster = null;
    let match = 'none';
    let confidence = 0;
    if (d.cluster_key && byKey.has(d.cluster_key)) {
      cluster = byKey.get(d.cluster_key); match = 'exact'; confidence = 1;
    } else if (norm(d.tz_clause) && byClause.has(norm(d.tz_clause))) {
      cluster = byClause.get(norm(d.tz_clause)); match = 'place'; confidence = 0.6;
    } else if (norm(d.source_fragment) && byFrag.has(norm(d.source_fragment))) {
      cluster = byFrag.get(norm(d.source_fragment)); match = 'text'; confidence = 0.5;
    }
    proposals.push({ decision: d, cluster_id: cluster ? cluster.id : null, cluster, match, confidence });
  }
  // Конфликт: несколько решений претендуют на один новый кластер.
  const countByCluster = new Map();
  for (const p of proposals) {
    if (p.cluster_id) countByCluster.set(p.cluster_id, (countByCluster.get(p.cluster_id) || 0) + 1);
  }
  for (const p of proposals) {
    if (p.cluster_id && countByCluster.get(p.cluster_id) > 1) p.conflict = true;
  }
  return proposals;
}

// Гарантия отсутствия дублей в экспорте: одна строка на место (cluster_id, иначе
// абзац+диапазон). Первая по порядку побеждает.
function dedupeExportRows(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows || []) {
    const key = r.cluster_id || r.id
      || `${r.paragraph_index ?? ''}:${r.char_start ?? ''}:${r.char_end ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

// --- DB-обвязка --------------------------------------------------------------

// exec(tx) — исполнитель: транзакция или общий db. Позволяет вызывать хелперы
// как внутри чужой транзакции (движок стадий), так и самостоятельно.
const exec = (tx) => tx || db;

// Создать прогон (status='running'). НЕ трогает указатель/архивацию — активация
// отдельным шагом (activateRun) после успеха. Возвращает runId.
async function beginRun(tenderId, scope, opts = {}, tx) {
  const e = exec(tx);
  const runId = newId();
  const kind = opts.kind || (scope === SCOPE_PIPELINE ? 'pipeline' : 'stage');
  await e.queryRun(
    `INSERT INTO analysis_runs
       (id, tender_id, stage, kind, documents_revision_id, config_version, started_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'running')`,
    runId, tenderId, opts.stage ?? null, kind,
    opts.documentsRevisionId ?? null, opts.configVersion ?? null, nowIso(),
  );
  return runId;
}

// Активировать прогон по успеху: архивировать прежний актуальный прогон этого
// scope (superseded_at), перевести указатель на runId, пометить прогон completed.
async function activateRun(tenderId, scope, runId, opts = {}, tx) {
  const e = exec(tx);
  const now = nowIso();
  const prev = await e.queryOne(
    `SELECT analysis_run_id FROM analysis_active_runs WHERE tender_id = ? AND scope = ?`,
    tenderId, scope,
  );
  if (prev && prev.analysis_run_id && prev.analysis_run_id !== runId) {
    await e.queryRun(
      `UPDATE analysis_runs SET superseded_at = ? WHERE id = ? AND superseded_at IS NULL`,
      now, prev.analysis_run_id,
    );
  }
  await e.queryRun(
    `UPDATE analysis_runs
        SET status = 'completed', finished_at = ?,
            summary = COALESCE(?, summary),
            documents_revision_id = COALESCE(?, documents_revision_id),
            config_version = COALESCE(?, config_version)
      WHERE id = ?`,
    now, opts.summary ?? null, opts.documentsRevisionId ?? null, opts.configVersion ?? null, runId,
  );
  await e.queryRun(
    `INSERT INTO analysis_active_runs
       (tender_id, scope, documents_revision_id, config_version, analysis_run_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (tender_id, scope) DO UPDATE SET
       documents_revision_id = EXCLUDED.documents_revision_id,
       config_version = EXCLUDED.config_version,
       analysis_run_id = EXCLUDED.analysis_run_id,
       updated_at = EXCLUDED.updated_at`,
    tenderId, scope, opts.documentsRevisionId ?? null, opts.configVersion ?? null, runId, now,
  );
}

// Пометить прогон как проваленный. Указатель НЕ трогаем — прежний актуальный
// прогон остаётся активным.
async function failRun(runId, summary, tx) {
  const e = exec(tx);
  await e.queryRun(
    `UPDATE analysis_runs SET status = 'failed', finished_at = ?, summary = COALESCE(?, summary) WHERE id = ?`,
    nowIso(), summary ?? null, runId,
  );
}

async function getActiveRunId(tenderId, scope, tx) {
  const row = await exec(tx).queryOne(
    `SELECT analysis_run_id FROM analysis_active_runs WHERE tender_id = ? AND scope = ?`,
    tenderId, scope,
  );
  return row ? row.analysis_run_id : null;
}
const getActivePipelineRunId = (tenderId, tx) => getActiveRunId(tenderId, SCOPE_PIPELINE, tx);
const getActiveStageRunId = (tenderId, stage, tx) => getActiveRunId(tenderId, stageScope(stage), tx);

async function getActiveStageRunIds(tenderId, tx) {
  const rows = await exec(tx).queryAll(
    `SELECT analysis_run_id FROM analysis_active_runs WHERE tender_id = ? AND scope LIKE 'stage:%'`,
    tenderId,
  );
  return rows.map((r) => r.analysis_run_id).filter(Boolean);
}

// Готовый фрагмент WHERE для скоупа таблицы `issues` (legacy issue-путь) по
// АКТУАЛЬНЫМ stage-прогонам. Возвращает { sql, params } для вставки в конец WHERE
// (перед ORDER BY) с добавлением params в конец списка. Нет активных прогонов →
// заведомо ложное условие (снимок пуст).
async function issuesRunFilter(tenderId, alias = 'i') {
  const ids = await getActiveStageRunIds(tenderId);
  if (!ids.length) return { sql: ' AND 1 = 0', params: [] };
  const ph = ids.map(() => '?').join(', ');
  return { sql: ` AND ${alias}.analysis_run_id IN (${ph})`, params: ids };
}

// Снять указатели scope 'stage:N' для stage >= from (используется resetStage).
async function clearStagePointers(tenderId, fromStage, tx) {
  const e = exec(tx);
  const rows = await e.queryAll(
    `SELECT scope, analysis_run_id FROM analysis_active_runs WHERE tender_id = ? AND scope LIKE 'stage:%'`,
    tenderId,
  );
  for (const r of rows) {
    const n = Number(String(r.scope).split(':')[1]);
    if (Number.isFinite(n) && n >= fromStage) {
      await e.queryRun('DELETE FROM analysis_active_runs WHERE tender_id = ? AND scope = ?', tenderId, r.scope);
    }
  }
}

// Текущие ревизия документов / версия конфигурации тендера (для beginRun/activate).
async function currentDocumentsRevision(tenderId, tx) {
  const docs = await exec(tx).queryAll(
    'SELECT id, version, extracted_text FROM documents WHERE tender_id = ?', tenderId,
  );
  return computeDocumentsRevision(docs);
}
const currentConfigVersion = () => computeConfigVersion(process.env);

// Гарантирует наличие АКТУАЛЬНОГО pipeline-прогона: вернёт id активного либо
// создаст и активирует пустой (для одиночных build*/debug-путей, которым нужен
// прогон-адресат). Оркестратор runPipeline вместо этого начинает НОВЫЙ прогон.
async function ensurePipelineRun(tenderId) {
  const active = await getActivePipelineRunId(tenderId);
  if (active) return active;
  const documentsRevisionId = await currentDocumentsRevision(tenderId);
  const configVersion = currentConfigVersion();
  const runId = await beginRun(tenderId, SCOPE_PIPELINE, { documentsRevisionId, configVersion });
  await activateRun(tenderId, SCOPE_PIPELINE, runId, { documentsRevisionId, configVersion });
  return runId;
}

// --- Перенос решений (явное сопоставление + подтверждение) -------------------

// Предложения переноса: решения последнего АРХИВНОГО pipeline-прогона,
// сопоставленные с ОТКРЫТЫМИ (ещё не решёнными) кластерами АКТУАЛЬНОГО прогона.
async function listCarryOverProposals(tenderId) {
  const activeRunId = await getActivePipelineRunId(tenderId);
  if (!activeRunId) return { active_run_id: null, from_run_id: null, proposals: [] };

  const prevRun = await db.queryOne(
    `SELECT id FROM analysis_runs
      WHERE tender_id = ? AND kind = 'pipeline' AND superseded_at IS NOT NULL AND id <> ?
      ORDER BY superseded_at DESC LIMIT 1`,
    tenderId, activeRunId,
  );
  if (!prevRun) return { active_run_id: activeRunId, from_run_id: null, proposals: [] };

  const oldDecisions = await db.queryAll(
    `SELECT rd.*, c.tz_clause AS tz_clause, c.cluster_title AS cluster_title
       FROM review_decisions rd
       LEFT JOIN issue_clusters c ON c.id = rd.cluster_id
      WHERE rd.analysis_run_id = ? AND rd.cluster_id IS NOT NULL AND rd.decision <> 'reject'`,
    prevRun.id,
  );
  const newClusters = await db.queryAll(
    `SELECT c.*,
            (SELECT d.source_fragment FROM issue_cluster_items ci
               JOIN draft_issues d ON d.id = ci.draft_issue_id
              WHERE ci.cluster_id = c.id AND ci.item_role = 'primary' LIMIT 1) AS source_fragment
       FROM issue_clusters c
      WHERE c.tender_id = ? AND c.analysis_run_id = ?`,
    tenderId, activeRunId,
  );
  const decided = await db.queryAll(
    `SELECT cluster_id FROM review_decisions WHERE analysis_run_id = ? AND cluster_id IS NOT NULL`,
    activeRunId,
  );
  const decidedSet = new Set(decided.map((r) => r.cluster_id));
  const openClusters = newClusters.filter((c) => !decidedSet.has(c.id));

  const proposals = matchDecisionsToClusters(oldDecisions, openClusters).filter((p) => p.cluster_id);
  return { active_run_id: activeRunId, from_run_id: prevRun.id, proposals };
}

// Подтвердить перенос выбранных решений в АКТУАЛЬНЫЙ прогон.
// selections: [{ decision_id (из прошлого прогона), cluster_id (актуального) }].
async function confirmCarryOvers(tenderId, selections) {
  const activeRunId = await getActivePipelineRunId(tenderId);
  if (!activeRunId) return { applied: 0, active_run_id: null };
  let applied = 0;
  await db.transaction(async (tx) => {
    for (const sel of selections || []) {
      if (!sel || !sel.decision_id || !sel.cluster_id) continue;
      const old = await tx.queryOne('SELECT * FROM review_decisions WHERE id = ?', sel.decision_id);
      if (!old) continue;
      const cluster = await tx.queryOne(
        'SELECT cluster_key FROM issue_clusters WHERE id = ? AND tender_id = ? AND analysis_run_id = ?',
        sel.cluster_id, tenderId, activeRunId,
      );
      if (!cluster) continue;
      // Одно активное решение на кластер в актуальном прогоне.
      await tx.queryRun(
        'DELETE FROM review_decisions WHERE cluster_id = ? AND analysis_run_id = ?',
        sel.cluster_id, activeRunId,
      );
      await tx.queryRun(
        `INSERT INTO review_decisions
           (id, issue_id, cluster_id, analysis_run_id, cluster_key, decision,
            edited_redaction, final_comment, target_text, decided_at)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId(), sel.cluster_id, activeRunId, cluster.cluster_key, old.decision,
        old.edited_redaction, old.final_comment, old.target_text, nowIso(),
      );
      applied += 1;
    }
  });
  return { applied, active_run_id: activeRunId };
}

module.exports = {
  // константы / scope
  SCOPE_PIPELINE,
  stageScope,
  // чистое ядро (офлайн-тесты)
  computeDocumentsRevision,
  computeConfigVersion,
  clusterRunId,
  selectActiveRunIds,
  matchDecisionsToClusters,
  dedupeExportRows,
  // DB: жизненный цикл прогона
  beginRun,
  activateRun,
  failRun,
  getActivePipelineRunId,
  getActiveStageRunId,
  getActiveStageRunIds,
  issuesRunFilter,
  clearStagePointers,
  currentDocumentsRevision,
  currentConfigVersion,
  ensurePipelineRun,
  // DB: перенос решений
  listCarryOverProposals,
  confirmCarryOvers,
};
