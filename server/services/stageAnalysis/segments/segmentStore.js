'use strict';

// Хранилище сегментов анализа (таблица analysis_segments).
//
// Одна строка = одна часть ТЗ в разрезе стадии: план нарезки (заголовочный
// контекст, диапазон блоков, размер), СТАТУС (pending|running|completed|failed),
// попытки, ошибка и СОХРАНЁННЫЙ результат части. Даёт три вещи:
//   • инженер видит, какая именно часть ТЗ не досчиталась;
//   • повтор стадии переиспользует уже посчитанные части (сверка input_hash) —
//     дорогой LLM-прогон не повторяется целиком;
//   • можно перезапустить ОДИН сегмент (requestRetry) — остальные подтянутся
//     из сохранённого результата.
//
// Запись best-effort: сбой хранилища НЕ роняет анализ (он лишь теряет кэш и
// видимость статуса), поэтому все методы ловят ошибку и пишут предупреждение.
// В офлайн-тестах store просто не передаётся в runLlmStage.

const db = require('../../../db/connection');
const { newId, nowIso } = require('../../../utils/ids');

const STATUS = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
});

function safeParse(v) {
  if (v == null || v === '') return null;
  try { return JSON.parse(v); } catch (_e) { return null; }
}

// Планирование нарезки: upsert строк под текущий набор сегментов.
// Готовая часть с ТЕМ ЖЕ input_hash сохраняет статус и результат (кэш);
// изменившаяся — сбрасывается в pending. Лишние строки прошлой нарезки удаляются.
async function planSegments(tenderId, stage, { revisionId = null, runId = null, segments = [] } = {}) {
  const total = segments.length;
  const now = nowIso();
  await db.transaction(async (tx) => {
    for (const s of segments) {
      // eslint-disable-next-line no-await-in-loop
      await tx.queryRun(
        `INSERT INTO analysis_segments (
           id, tender_id, analysis_stage, analysis_run_id, document_revision_id,
           segment_index, segment_total, segment_key, heading_path,
           first_block_index, last_block_index, chars, tokens_estimate, input_hash,
           status, attempts, findings_count, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
         ON CONFLICT (tender_id, analysis_stage, segment_index) DO UPDATE SET
           document_revision_id = EXCLUDED.document_revision_id,
           segment_total        = EXCLUDED.segment_total,
           segment_key          = EXCLUDED.segment_key,
           heading_path         = EXCLUDED.heading_path,
           first_block_index    = EXCLUDED.first_block_index,
           last_block_index     = EXCLUDED.last_block_index,
           chars                = EXCLUDED.chars,
           tokens_estimate      = EXCLUDED.tokens_estimate,
           input_hash           = EXCLUDED.input_hash,
           -- вход не изменился и часть уже посчитана → бережём результат (кэш)
           status = CASE WHEN analysis_segments.input_hash = EXCLUDED.input_hash
                          AND analysis_segments.status = 'completed'
                         THEN analysis_segments.status ELSE 'pending' END,
           findings_json = CASE WHEN analysis_segments.input_hash = EXCLUDED.input_hash
                                 AND analysis_segments.status = 'completed'
                                THEN analysis_segments.findings_json ELSE NULL END,
           findings_count = CASE WHEN analysis_segments.input_hash = EXCLUDED.input_hash
                                  AND analysis_segments.status = 'completed'
                                 THEN analysis_segments.findings_count ELSE 0 END,
           error = NULL,
           updated_at = EXCLUDED.updated_at`,
        newId(), tenderId, stage, runId, revisionId,
        s.index, total, s.key || null, (s.headingPath || []).join(' › ') || null,
        s.firstBlockIndex ?? null, s.lastBlockIndex ?? null, s.chars ?? null, s.tokens ?? null,
        s.inputHash || null,
        STATUS.PENDING, now, now,
      );
    }
    await tx.queryRun(
      'DELETE FROM analysis_segments WHERE tender_id = ? AND analysis_stage = ? AND segment_index >= ?',
      tenderId, stage, total,
    );
  });
  return total;
}

// Сохранённый результат части — только если вход совпал (input_hash) и статус
// completed. Иначе часть считается заново.
async function getCompleted(tenderId, stage, index, inputHash) {
  const row = await db.queryOne(
    `SELECT status, input_hash, findings_json FROM analysis_segments
      WHERE tender_id = ? AND analysis_stage = ? AND segment_index = ?`,
    tenderId, stage, index,
  );
  if (!row || row.status !== STATUS.COMPLETED) return null;
  if (!inputHash || row.input_hash !== inputHash) return null;
  const findings = safeParse(row.findings_json);
  return Array.isArray(findings) ? findings : null;
}

async function markRunning(tenderId, stage, index) {
  await db.queryRun(
    `UPDATE analysis_segments
        SET status = ?, attempts = attempts + 1, started_at = ?, error = NULL, updated_at = ?
      WHERE tender_id = ? AND analysis_stage = ? AND segment_index = ?`,
    STATUS.RUNNING, nowIso(), nowIso(), tenderId, stage, index,
  );
}

async function saveSuccess(tenderId, stage, index, { findings, runId = null } = {}) {
  const list = Array.isArray(findings) ? findings : [];
  await db.queryRun(
    `UPDATE analysis_segments
        SET status = ?, findings_json = ?, findings_count = ?, analysis_run_id = COALESCE(?, analysis_run_id),
            error = NULL, finished_at = ?, updated_at = ?
      WHERE tender_id = ? AND analysis_stage = ? AND segment_index = ?`,
    STATUS.COMPLETED, JSON.stringify(list), list.length, runId, nowIso(), nowIso(),
    tenderId, stage, index,
  );
}

async function saveFailure(tenderId, stage, index, error) {
  await db.queryRun(
    `UPDATE analysis_segments
        SET status = ?, error = ?, finished_at = ?, updated_at = ?
      WHERE tender_id = ? AND analysis_stage = ? AND segment_index = ?`,
    STATUS.FAILED, String((error && error.message) || error || 'ошибка').slice(0, 2000),
    nowIso(), nowIso(), tenderId, stage, index,
  );
}

async function listSegments(tenderId, stage) {
  const params = stage ? [tenderId, stage] : [tenderId];
  const where = stage ? 'tender_id = ? AND analysis_stage = ?' : 'tender_id = ?';
  const rows = await db.queryAll(
    `SELECT id, tender_id, analysis_stage, analysis_run_id, document_revision_id,
            segment_index, segment_total, segment_key, heading_path,
            first_block_index, last_block_index, chars, tokens_estimate,
            status, attempts, findings_count, error, started_at, finished_at, updated_at
       FROM analysis_segments WHERE ${where}
      ORDER BY analysis_stage ASC, segment_index ASC`,
    ...params,
  );
  return rows;
}

async function getSegment(tenderId, stage, index) {
  return db.queryOne(
    `SELECT * FROM analysis_segments
      WHERE tender_id = ? AND analysis_stage = ? AND segment_index = ?`,
    tenderId, stage, index,
  );
}

// Перезапуск ОДНОГО сегмента: гасим сохранённый результат — следующий прогон
// стадии пересчитает только его, остальные части возьмёт из кэша.
async function requestRetry(tenderId, stage, index) {
  const res = await db.queryRun(
    `UPDATE analysis_segments
        SET status = ?, findings_json = NULL, findings_count = 0, error = NULL,
            started_at = NULL, finished_at = NULL, updated_at = ?
      WHERE tender_id = ? AND analysis_stage = ? AND segment_index = ?`,
    STATUS.PENDING, nowIso(), tenderId, stage, index,
  );
  return (res && (res.changes ?? res.rowCount)) || 0;
}

// Сводка по частям стадии — для карточки стадии и страницы отладки.
function summarize(rows) {
  const byStatus = {};
  let findings = 0;
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    findings += Number(r.findings_count) || 0;
  }
  return {
    total: rows.length,
    by_status: byStatus,
    completed: byStatus[STATUS.COMPLETED] || 0,
    failed: byStatus[STATUS.FAILED] || 0,
    findings,
  };
}

// Best-effort обёртка для одной стадии одного тендера: то, что получает
// runLlmStage. Ошибки хранилища не роняют анализ — деградируем до «без кэша».
function makeStageSegmentStore({ tenderId, stage, revisionId = null, runId = null, logTag = 'segmentStore' }) {
  const guard = async (what, fn, fallback = null) => {
    try {
      return await fn();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[${logTag}] сегменты (${what}) стадии ${stage}: ${e.message}`);
      return fallback;
    }
  };
  return {
    tenderId,
    stage,
    plan: (segments) => guard('plan', () => planSegments(tenderId, stage, { revisionId, runId, segments }), 0),
    getCompleted: (index, hash) => guard('read', () => getCompleted(tenderId, stage, index, hash)),
    markRunning: (index) => guard('running', () => markRunning(tenderId, stage, index)),
    saveSuccess: (index, findings) => guard('save', () => saveSuccess(tenderId, stage, index, { findings, runId })),
    saveFailure: (index, error) => guard('fail', () => saveFailure(tenderId, stage, index, error)),
  };
}

module.exports = {
  STATUS,
  planSegments,
  getCompleted,
  markRunning,
  saveSuccess,
  saveFailure,
  listSegments,
  getSegment,
  requestRetry,
  summarize,
  makeStageSegmentStore,
};
