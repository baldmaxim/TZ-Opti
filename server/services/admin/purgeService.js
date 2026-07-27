'use strict';

// ADMIN PURGE — ЕДИНСТВЕННОЕ место, где история анализа удаляется физически.
//
// Остальная система историю не трогает: повторный анализ создаёт новый снимок и
// архивирует прежний, сброс стадии снимает указатели, а запись в завершённый
// снимок запрещена стражем (analysisRuns.assertRunWritable). Поэтому «почистить»
// — отдельная осознанная операция администратора, а не побочный эффект рабочего
// действия.
//
// Инварианты:
//   • НИКОГДА не удаляется АКТУАЛЬНЫЙ снимок (тот, на который смотрит указатель)
//     — что портал показывает сейчас, purge снести не может;
//   • по умолчанию dry-run: команда сначала показывает, что будет удалено;
//   • удаление требует явного подтверждения (confirm === tenderId) — случайный
//     вызов ничего не сносит;
//   • keepLast N архивных прогонов на scope можно сохранить (последний архив —
//     основа для переноса решений, listCarryOverProposals);
//   • всё пишется в журнал аудита (category='admin').
//
// Чистое ядро (selectRunsToPurge) отделено от SQL и тестируется офлайн.

const db = require('../../db/connection');
const audit = require('../audit/auditService');

// Таблицы, привязанные к прогону. Порядок — от зависимых к корню: issue_cluster_items
// удаляются через свои кластеры, review_decisions/issues — по analysis_run_id.
const RUN_SCOPED_TABLES = Object.freeze([
  'self_analysis_results',
  'issue_reviews',
  'review_decisions',
  'analysis_signals',
  'issues',
]);

// --- Чистое ядро --------------------------------------------------------------

// Какие прогоны можно удалять. runs: [{ id, scope?, kind, status, superseded_at,
// started_at }], activeIds — множество id из указателей.
// Правила: активный — никогда; running — никогда (его кто-то пишет прямо сейчас);
// из остальных (архивные + failed) на каждый scope/kind сохраняем keepLast самых
// свежих по started_at.
function selectRunsToPurge(runs = [], activeIds = new Set(), { keepLast = 1, olderThan = null } = {}) {
  const keep = new Set();
  const candidates = [];
  for (const r of runs || []) {
    if (!r || !r.id) continue;
    if (activeIds.has(r.id)) { keep.add(r.id); continue; }
    if (r.status === 'running') { keep.add(r.id); continue; }
    candidates.push(r);
  }
  const groupKey = (r) => `${r.kind || 'stage'}:${r.stage ?? ''}`;
  const byGroup = new Map();
  for (const r of candidates) {
    const k = groupKey(r);
    if (!byGroup.has(k)) byGroup.set(k, []);
    byGroup.get(k).push(r);
  }
  const purge = [];
  for (const group of byGroup.values()) {
    // Свежие первыми; при совпадении времени — по id, чтобы порядок был
    // детерминированным (иначе «какой архив сохранить» зависело бы от БД).
    group.sort((a, b) => String(b.started_at || '').localeCompare(String(a.started_at || ''))
      || String(b.id).localeCompare(String(a.id)));
    group.forEach((r, idx) => {
      if (idx < Math.max(0, keepLast)) { keep.add(r.id); return; }
      if (olderThan && String(r.started_at || '') >= String(olderThan)) { keep.add(r.id); return; }
      purge.push(r);
    });
  }
  return { purge, keep: [...keep] };
}

// --- DB -----------------------------------------------------------------------

async function loadRuns(tenderId) {
  return db.queryAll(
    `SELECT id, tender_id, stage, kind, status, superseded_at, started_at, finished_at
       FROM analysis_runs WHERE tender_id = ? ORDER BY started_at DESC, id DESC`,
    tenderId,
  );
}

async function loadActiveIds(tenderId) {
  const rows = await db.queryAll(
    'SELECT analysis_run_id FROM analysis_active_runs WHERE tender_id = ?', tenderId,
  );
  return new Set(rows.map((r) => r.analysis_run_id).filter(Boolean));
}

// Сколько строк в каждой таблице привязано к этим прогонам (для отчёта dry-run).
async function countRows(runIds) {
  if (!runIds.length) return {};
  const ph = runIds.map(() => '?').join(', ');
  const out = {};
  for (const table of RUN_SCOPED_TABLES) {
    // eslint-disable-next-line no-await-in-loop
    const row = await db.queryOne(
      `SELECT COUNT(*) AS c FROM ${table} WHERE analysis_run_id IN (${ph})`, ...runIds,
    );
    out[table] = Number((row && row.c) || 0);
  }
  const drafts = await db.queryOne(
    `SELECT COUNT(*) AS c FROM draft_issues WHERE analysis_run_id IN (${ph})`, ...runIds,
  );
  out.draft_issues = Number((drafts && drafts.c) || 0);
  const clusters = await db.queryOne(
    `SELECT COUNT(*) AS c FROM issue_clusters WHERE analysis_run_id IN (${ph})`, ...runIds,
  );
  out.issue_clusters = Number((clusters && clusters.c) || 0);
  return out;
}

// Покажет, что будет удалено, но НЕ удалит.
async function planPurge(tenderId, opts = {}) {
  const runs = await loadRuns(tenderId);
  const activeIds = await loadActiveIds(tenderId);
  const { purge, keep } = selectRunsToPurge(runs, activeIds, opts);
  const ids = purge.map((r) => r.id);
  return {
    tender_id: tenderId,
    keep_last: opts.keepLast ?? 1,
    older_than: opts.olderThan || null,
    runs_total: runs.length,
    runs_kept: keep.length,
    runs_to_purge: purge.map((r) => ({
      id: r.id, kind: r.kind, stage: r.stage, status: r.status, started_at: r.started_at,
      superseded_at: r.superseded_at,
    })),
    rows: await countRows(ids),
  };
}

// Физическое удаление. Без confirm === tenderId ничего не делает (возвращает план
// с dry_run:true). Активные и running-прогоны не удаляются ни при каких опциях.
async function purgeTenderHistory(tenderId, opts = {}) {
  const plan = await planPurge(tenderId, opts);
  const ids = plan.runs_to_purge.map((r) => r.id);
  const confirmed = opts.confirm === tenderId;
  if (!confirmed || !ids.length) {
    return { ...plan, dry_run: true, deleted: false, reason: confirmed ? 'нечего удалять' : 'нужен confirm = id тендера' };
  }

  await db.transaction(async (tx) => {
    const ph = ids.map(() => '?').join(', ');
    // Кластеры: сначала элементы (внешний ключ), потом сами кластеры.
    const clusters = await tx.queryAll(
      `SELECT id FROM issue_clusters WHERE analysis_run_id IN (${ph})`, ...ids,
    );
    if (clusters.length) {
      const cph = clusters.map(() => '?').join(', ');
      const cids = clusters.map((c) => c.id);
      await tx.queryRun(`DELETE FROM issue_cluster_items WHERE cluster_id IN (${cph})`, ...cids);
      await tx.queryRun(`DELETE FROM review_decisions WHERE cluster_id IN (${cph})`, ...cids);
    }
    // Исключения, порождённые issues удаляемых прогонов.
    await tx.queryRun(
      `DELETE FROM tz_excluded_ranges WHERE source_issue_id IN
         (SELECT id FROM issues WHERE analysis_run_id IN (${ph}))`,
      ...ids,
    );
    await tx.queryRun(
      `DELETE FROM review_decisions WHERE issue_id IN
         (SELECT id FROM issues WHERE analysis_run_id IN (${ph}))`,
      ...ids,
    );
    for (const table of ['issue_clusters', ...RUN_SCOPED_TABLES, 'draft_issues']) {
      // eslint-disable-next-line no-await-in-loop
      await tx.queryRun(`DELETE FROM ${table} WHERE analysis_run_id IN (${ph})`, ...ids);
    }
    await tx.queryRun(`DELETE FROM analysis_runs WHERE id IN (${ph})`, ...ids);
  });

  const actor = opts.actor || null;
  await audit.record({
    requestId: opts.requestId || null,
    tenantId: actor && actor.tenantId,
    actorSub: actor && actor.subject,
    actorEmail: actor && actor.email,
    actorRoles: actor && actor.roles,
    authMethod: actor && actor.authMethod,
    action: 'admin.purge.runs',
    category: 'admin',
    outcome: 'allowed',
    resourceType: 'analysis_run',
    tenderId,
    reason: `физическое удаление ${ids.length} архивных прогонов`,
    meta: { runs: ids, rows: plan.rows, keep_last: plan.keep_last, older_than: plan.older_than },
  });

  return { ...plan, dry_run: false, deleted: true, runs_deleted: ids.length };
}

// Полезно для CLI: доступные тендеры с числом архивных прогонов.
async function purgeCandidates() {
  return db.queryAll(
    `SELECT r.tender_id, COUNT(*) AS archived
       FROM analysis_runs r
      WHERE r.superseded_at IS NOT NULL
         OR r.status = 'failed'
      GROUP BY r.tender_id ORDER BY archived DESC`,
  );
}

module.exports = {
  RUN_SCOPED_TABLES,
  selectRunsToPurge, // чистое ядро (офлайн-тест)
  planPurge,
  purgeTenderHistory,
  purgeCandidates,
};
