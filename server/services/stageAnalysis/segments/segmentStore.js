'use strict';

// Части ТЗ (сегменты) — ДВЕ таблицы с разной природой, а не одна строка на обе роли.
//
//   analysis_segments      — КЭШ результата части, скоупленный РЕВИЗИЕЙ документов.
//                            Ключ: (тендер, стадия, ревизия, номер части).
//                            Перезаписываемый по определению: это ускоритель.
//   analysis_run_segments  — НЕИЗМЕНЯЕМАЯ ИСТОРИЯ выполнения части в ОДНОМ прогоне.
//                            Ключ: (analysis_run_id, номер части). Пишет только
//                            прогон-владелец и только пока он running.
//
// Зачем разделено. Раньше это была одна строка на (тендер, стадия, часть):
// повтор стадии ЗАТИРАЛ её, поэтому «на какой части упал вчерашний прогон» было
// не восстановить, а колонка analysis_run_id показывала лишь последнего писателя
// — снимок выглядел неизменяемым, а его сегментная летопись таковой не была.
// Теперь два последовательных прогона лежат рядом: у каждого свой набор строк
// истории, а кэш между ними переиспользуется (в истории это видно как
// source='cache' — часть засчитана, но модель по ней не гонялась).
//
// Что сохранено:
//   • переиспользование посчитанных частей (сверка input_hash + config_version);
//   • точечный retry одной части (invalidateCache гасит ТОЛЬКО её кэш).
//
// Запись best-effort: сбой хранилища НЕ роняет анализ (теряется кэш и видимость
// статуса), поэтому обёртка makeStageSegmentStore ловит ошибки и логирует.

const db = require('../../../db/connection');
const { newId, nowIso } = require('../../../utils/ids');

// Статусы ИСТОРИИ выполнения части (analysis_run_segments).
const STATUS = Object.freeze({
  PENDING: 'pending',         // прогон до части не дошёл
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  INTERRUPTED: 'interrupted', // прогон оборван, пока часть считалась
  SKIPPED: 'skipped',         // прогон кончился раньше, чем очередь дошла до части
});

// Откуда взят результат части (для честной картины «что реально гонялось»).
const SOURCE = Object.freeze({
  LLM: 'llm',
  CACHE: 'cache',
  CHECKPOINT: 'checkpoint',
});

// Незавершённые состояния истории: их закрывает финализатор прогона.
const OPEN_STATUSES = [STATUS.PENDING, STATUS.RUNNING];

function safeParse(v) {
  if (v == null || v === '') return null;
  try { return JSON.parse(v); } catch (_e) { return null; }
}

const rev = (r) => (r == null ? '' : String(r));

// --- Кэш (analysis_segments) ---------------------------------------------------

// Записать/обновить план нарезки в кэше текущей ревизии. Готовая часть с ТЕМ ЖЕ
// input_hash и той же версией конфигурации сохраняет результат; изменившаяся —
// теряет его. Лишние части прошлой нарезки ЭТОЙ ЖЕ ревизии удаляются.
async function planCache(tenderId, stage, { revisionId = null, configVersion = null, runId = null, segments = [] } = {}) {
  const total = segments.length;
  const now = nowIso();
  const revision = rev(revisionId);
  await db.transaction(async (tx) => {
    for (const s of segments) {
      // eslint-disable-next-line no-await-in-loop
      await tx.queryRun(
        `INSERT INTO analysis_segments (
           id, tender_id, analysis_stage, document_revision_id, config_version,
           segment_index, segment_total, segment_key, heading_path,
           first_block_index, last_block_index, chars, tokens_estimate, input_hash,
           status, findings_count, computed_run_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)
         ON CONFLICT (tender_id, analysis_stage, document_revision_id, segment_index) DO UPDATE SET
           segment_total   = EXCLUDED.segment_total,
           segment_key     = EXCLUDED.segment_key,
           heading_path    = EXCLUDED.heading_path,
           first_block_index = EXCLUDED.first_block_index,
           last_block_index  = EXCLUDED.last_block_index,
           chars           = EXCLUDED.chars,
           tokens_estimate = EXCLUDED.tokens_estimate,
           config_version  = EXCLUDED.config_version,
           input_hash      = EXCLUDED.input_hash,
           -- вход и конфигурация не изменились и результат есть → бережём кэш
           status = CASE WHEN analysis_segments.input_hash = EXCLUDED.input_hash
                          AND analysis_segments.config_version IS NOT DISTINCT FROM EXCLUDED.config_version
                          AND analysis_segments.status = 'completed'
                         THEN analysis_segments.status ELSE 'pending' END,
           findings_json = CASE WHEN analysis_segments.input_hash = EXCLUDED.input_hash
                                 AND analysis_segments.config_version IS NOT DISTINCT FROM EXCLUDED.config_version
                                 AND analysis_segments.status = 'completed'
                                THEN analysis_segments.findings_json ELSE NULL END,
           findings_count = CASE WHEN analysis_segments.input_hash = EXCLUDED.input_hash
                                  AND analysis_segments.config_version IS NOT DISTINCT FROM EXCLUDED.config_version
                                  AND analysis_segments.status = 'completed'
                                 THEN analysis_segments.findings_count ELSE 0 END,
           updated_at = EXCLUDED.updated_at`,
        newId(), tenderId, stage, revision, configVersion,
        s.index, total, s.key || null, (s.headingPath || []).join(' › ') || null,
        s.firstBlockIndex ?? null, s.lastBlockIndex ?? null, s.chars ?? null, s.tokens ?? null,
        s.inputHash || null,
        'pending', now, now,
      );
    }
    await tx.queryRun(
      `DELETE FROM analysis_segments
        WHERE tender_id = ? AND analysis_stage = ? AND document_revision_id = ? AND segment_index >= ?`,
      tenderId, stage, revision, total,
    );
  });
  await pruneCache(tenderId, stage, revision);
  return total;
}

// Кэш скоуплен ревизией — значит, он растёт с каждой новой версией ТЗ. Держим
// ТЕКУЩУЮ ревизию и KEEP_REVISIONS-1 предыдущих (возврат к прошлой версии ТЗ
// ещё переиспользуется), остальные удаляем. История прогонов при этом не
// страдает: она в другой таблице и не удаляется никогда.
const KEEP_REVISIONS = 3;

async function pruneCache(tenderId, stage, currentRevision) {
  await db.queryRun(
    `DELETE FROM analysis_segments
      WHERE tender_id = ? AND analysis_stage = ?
        AND document_revision_id IN (
          SELECT document_revision_id FROM (
            SELECT document_revision_id,
                   ROW_NUMBER() OVER (ORDER BY MAX(updated_at) DESC) AS rn
              FROM analysis_segments
             WHERE tender_id = ? AND analysis_stage = ? AND document_revision_id <> ?
             GROUP BY document_revision_id
          ) t WHERE rn >= ?)`,
    tenderId, stage, tenderId, stage, rev(currentRevision), KEEP_REVISIONS,
  );
}

// Сохранённый результат части: только при совпадении ревизии, input_hash и
// версии конфигурации. Иначе часть считается заново.
async function getCompleted(tenderId, stage, index, inputHash, { revisionId = null, configVersion = undefined } = {}) {
  const row = await db.queryOne(
    `SELECT status, input_hash, config_version, findings_json FROM analysis_segments
      WHERE tender_id = ? AND analysis_stage = ? AND document_revision_id = ? AND segment_index = ?`,
    tenderId, stage, rev(revisionId), index,
  );
  if (!row || row.status !== 'completed') return null;
  if (!inputHash || row.input_hash !== inputHash) return null;
  if (configVersion !== undefined && (row.config_version || null) !== (configVersion || null)) return null;
  const findings = safeParse(row.findings_json);
  return Array.isArray(findings) ? findings : null;
}

// КРОСС-РЕВИЗИОННЫЙ поиск: completed-часть с ТЕМ ЖЕ input_hash и той же
// версией конфигурации из ЛЮБОЙ хранимой ревизии, независимо от segment_index
// (нарезка новой ревизии могла сдвинуться). Безопасно: в кэше лежат СЫРЫЕ
// находки модели (цитаты без координат) — локализация выполняется после подъёма
// из кэша против текущих блоков (llmStage), чужие координаты не переносятся.
// Это и есть селективный пересчёт: изменённые части новой согласованной версии
// считаются заново, нетронутые поднимаются из кэша прошлой ревизии.
async function getCompletedByHash(tenderId, stage, inputHash, { configVersion = undefined } = {}) {
  if (!inputHash) return null;
  const params = [tenderId, stage, inputHash];
  let configFilter = '';
  if (configVersion !== undefined) {
    configFilter = 'AND config_version IS NOT DISTINCT FROM ?';
    params.push(configVersion || null);
  }
  const row = await db.queryOne(
    `SELECT findings_json FROM analysis_segments
      WHERE tender_id = ? AND analysis_stage = ? AND input_hash = ? AND status = 'completed'
        ${configFilter}
      ORDER BY updated_at DESC LIMIT 1`,
    ...params,
  );
  if (!row) return null;
  const findings = safeParse(row.findings_json);
  return Array.isArray(findings) ? findings : null;
}

async function saveCache(tenderId, stage, index, { findings, revisionId = null, configVersion = null, runId = null } = {}) {
  const list = Array.isArray(findings) ? findings : [];
  await db.queryRun(
    `UPDATE analysis_segments
        SET status = 'completed', findings_json = ?, findings_count = ?,
            config_version = COALESCE(?, config_version), computed_run_id = ?, updated_at = ?
      WHERE tender_id = ? AND analysis_stage = ? AND document_revision_id = ? AND segment_index = ?`,
    JSON.stringify(list), list.length, configVersion, runId, nowIso(),
    tenderId, stage, rev(revisionId), index,
  );
}

// Точечный retry: гасим кэш ОДНОЙ части — следующий прогон пересчитает её, а
// соседние возьмёт из кэша. Гасим по ВСЕМ ревизиям этой части сознательно:
// инженер нажимает «пересчитать» по тому, что видит, а какая ревизия будет
// актуальна на момент следующего запуска, знать неоткуда. Цена ошибки —
// один лишний вызов модели; цена обратного (не погасить нужную) — retry,
// который молча ничего не пересчитал.
async function invalidateCache(tenderId, stage, index) {
  const res = await db.queryRun(
    `UPDATE analysis_segments
        SET status = 'pending', findings_json = NULL, findings_count = 0, updated_at = ?
      WHERE tender_id = ? AND analysis_stage = ? AND segment_index = ?`,
    nowIso(), tenderId, stage, index,
  );
  return (res && (res.changes ?? res.rowCount)) || 0;
}

// Строка кэша (последняя по времени среди ревизий) — нужна проверке «такая часть
// вообще существует» перед постановкой retry.
async function getCacheSegment(tenderId, stage, index) {
  return db.queryOne(
    `SELECT * FROM analysis_segments
      WHERE tender_id = ? AND analysis_stage = ? AND segment_index = ?
      ORDER BY updated_at DESC LIMIT 1`,
    tenderId, stage, index,
  );
}

// --- История выполнения (analysis_run_segments) ---------------------------------

// План нарезки в истории прогона. Строки создаются в статусе pending: прогон,
// упавший на середине документа, оставляет видимым и то, до чего он не дошёл.
// Повторная попытка ЗАДАЧИ в том же прогоне обновляет план, но не сбрасывает
// уже посчитанные части (их статус остаётся completed).
async function planRunSegments(runId, tenderId, stage, {
  revisionId = null, configVersion = null, segments = [],
} = {}) {
  if (!runId) return 0;
  const total = segments.length;
  const now = nowIso();
  await db.transaction(async (tx) => {
    for (const s of segments) {
      // eslint-disable-next-line no-await-in-loop
      await tx.queryRun(
        `INSERT INTO analysis_run_segments (
           id, analysis_run_id, tender_id, analysis_stage, segment_index, segment_total,
           segment_key, heading_path, first_block_index, last_block_index, chars, tokens_estimate,
           document_revision_id, config_version, input_hash, status, attempts, findings_count,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
         ON CONFLICT (analysis_run_id, segment_index) DO UPDATE SET
           segment_total     = EXCLUDED.segment_total,
           segment_key       = EXCLUDED.segment_key,
           heading_path      = EXCLUDED.heading_path,
           first_block_index = EXCLUDED.first_block_index,
           last_block_index  = EXCLUDED.last_block_index,
           chars             = EXCLUDED.chars,
           tokens_estimate   = EXCLUDED.tokens_estimate,
           input_hash        = EXCLUDED.input_hash,
           updated_at        = EXCLUDED.updated_at`,
        newId(), runId, tenderId, stage, s.index, total,
        s.key || null, (s.headingPath || []).join(' › ') || null,
        s.firstBlockIndex ?? null, s.lastBlockIndex ?? null, s.chars ?? null, s.tokens ?? null,
        rev(revisionId), configVersion, s.inputHash || null, STATUS.PENDING, now, now,
      );
    }
  });
  return total;
}

// Переход строки истории. Пишем ТОЛЬКО в свой прогон (WHERE analysis_run_id) —
// чужие прогоны (в т.ч. завершённые) недосягаемы по построению запроса.
async function setRunSegment(runId, index, patchSql, params = []) {
  if (!runId) return 0;
  const res = await db.queryRun(
    `UPDATE analysis_run_segments SET ${patchSql}, updated_at = ?
      WHERE analysis_run_id = ? AND segment_index = ?`,
    ...params, nowIso(), runId, index,
  );
  return (res && (res.changes ?? res.rowCount)) || 0;
}

const markRunSegmentRunning = (runId, index) => setRunSegment(
  runId, index,
  'status = ?, attempts = attempts + 1, started_at = COALESCE(started_at, ?), error = NULL, source = NULL',
  [STATUS.RUNNING, nowIso()],
);

const markRunSegmentDone = (runId, index, { count = 0, source = SOURCE.LLM } = {}) => setRunSegment(
  runId, index,
  'status = ?, source = ?, findings_count = ?, error = NULL, started_at = COALESCE(started_at, ?), finished_at = ?',
  [STATUS.COMPLETED, source, Number(count) || 0, nowIso(), nowIso()],
);

const markRunSegmentFailed = (runId, index, error) => setRunSegment(
  runId, index,
  'status = ?, error = ?, finished_at = ?',
  [STATUS.FAILED, String((error && error.message) || error || 'ошибка').slice(0, 2000), nowIso()],
);

// Закрыть незавершённые части прогона при его финализации. Часть, которую
// считали в момент обрыва → interrupted; части, до которых очередь не дошла →
// skipped. После этого строки прогона неизменяемы: живых состояний в них нет.
// tx (опц.) — транзакция вызывающего: закрытие частей идёт тем же коммитом, что и
// остальная публикация снимка. Без tx — прежнее поведение (отдельные запросы).
async function finalizeRunSegments(runId, { reason = null, tx = null } = {}) {
  if (!runId) return { interrupted: 0, skipped: 0 };
  const exec = tx || db;
  const now = nowIso();
  const upd = async (from, to, msg) => {
    const res = await exec.queryRun(
      `UPDATE analysis_run_segments
          SET status = ?, error = COALESCE(error, ?), finished_at = COALESCE(finished_at, ?), updated_at = ?
        WHERE analysis_run_id = ? AND status = ?`,
      to, msg, now, now, runId, from,
    );
    return (res && (res.changes ?? res.rowCount)) || 0;
  };
  return {
    interrupted: await upd(STATUS.RUNNING, STATUS.INTERRUPTED, reason || 'прогон завершён, пока часть считалась'),
    skipped: await upd(STATUS.PENDING, STATUS.SKIPPED, reason || 'прогон завершён раньше, чем дошёл до этой части'),
  };
}

// --- Чтение для портала ----------------------------------------------------------

// Части КОНКРЕТНОГО прогона (история). Без runId — части последнего прогона
// стадии, у которого они есть.
async function listRunSegments(tenderId, stage, runId) {
  const rid = runId || await latestRunIdWithSegments(tenderId, stage);
  if (!rid) return [];
  return db.queryAll(
    `SELECT * FROM analysis_run_segments
      WHERE analysis_run_id = ? AND tender_id = ? AND analysis_stage = ?
      ORDER BY segment_index ASC`,
    rid, tenderId, stage,
  );
}

async function latestRunIdWithSegments(tenderId, stage) {
  const row = await db.queryOne(
    `SELECT s.analysis_run_id AS id
       FROM analysis_run_segments s
       JOIN analysis_runs r ON r.id = s.analysis_run_id
      WHERE s.tender_id = ? AND s.analysis_stage = ?
      ORDER BY r.started_at DESC, r.id DESC LIMIT 1`,
    tenderId, stage,
  );
  return row ? row.id : null;
}

// Прогоны стадии, по которым есть история частей (новые сверху).
async function listSegmentRuns(tenderId, stage, { limit = 10 } = {}) {
  return db.queryAll(
    `SELECT r.id, r.status, r.started_at, r.finished_at, r.documents_revision_id, r.config_version,
            COUNT(s.id)::int AS segments,
            COUNT(*) FILTER (WHERE s.status = 'completed')::int AS completed,
            COUNT(*) FILTER (WHERE s.status = 'failed')::int AS failed,
            COUNT(*) FILTER (WHERE s.source = 'llm')::int AS computed,
            COUNT(*) FILTER (WHERE s.source IN ('cache', 'checkpoint'))::int AS reused,
            COALESCE(SUM(s.findings_count), 0)::int AS findings
       FROM analysis_run_segments s
       JOIN analysis_runs r ON r.id = s.analysis_run_id
      WHERE s.tender_id = ? AND s.analysis_stage = ?
      GROUP BY r.id, r.status, r.started_at, r.finished_at, r.documents_revision_id, r.config_version
      ORDER BY r.started_at DESC, r.id DESC LIMIT ?`,
    tenderId, stage, Math.min(50, Math.max(1, Number(limit) || 10)),
  );
}

// Сводка по частям прогона — для карточки стадии и страницы отладки. Чистая.
function summarize(rows) {
  const byStatus = {};
  const bySource = {};
  let findings = 0;
  for (const r of rows || []) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    if (r.source) bySource[r.source] = (bySource[r.source] || 0) + 1;
    findings += Number(r.findings_count) || 0;
  }
  return {
    total: (rows || []).length,
    by_status: byStatus,
    by_source: bySource,
    completed: byStatus[STATUS.COMPLETED] || 0,
    failed: byStatus[STATUS.FAILED] || 0,
    // Части, реально отданные модели в этом прогоне (остальные пришли из кэша).
    computed: bySource[SOURCE.LLM] || 0,
    reused: (bySource[SOURCE.CACHE] || 0) + (bySource[SOURCE.CHECKPOINT] || 0),
    findings,
  };
}

// --- Обёртка для одного прогона одной стадии ------------------------------------

// То, что получает runLlmStage / stage5. Все методы привязаны к КОНКРЕТНОМУ
// прогону (runId) — сегмент физически не может быть записан в чужую историю.
// Ошибки хранилища не роняют анализ: деградируем до «без кэша и без летописи».
function makeStageSegmentStore({
  tenderId, stage, revisionId = null, configVersion = null, runId = null, logTag = 'segmentStore',
}) {
  const guard = async (what, fn, fallback = null) => {
    try {
      return await fn();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[${logTag}] сегменты (${what}) стадии ${stage}: ${e.message}`);
      return fallback;
    }
  };
  const scope = { revisionId, configVersion, runId };
  return {
    tenderId,
    stage,
    runId,
    plan: (segments) => guard('plan', async () => {
      const n = await planCache(tenderId, stage, { ...scope, segments });
      await planRunSegments(runId, tenderId, stage, { revisionId, configVersion, segments });
      return n;
    }, 0),
    getCompleted: (index, hash) => guard('read', async () => {
      const exact = await getCompleted(tenderId, stage, index, hash, scope);
      if (exact) return exact;
      // Каскад: часть с тем же входом, посчитанная для ДРУГОЙ ревизии
      // (селективный пересчёт после согласованной версии). Найденное дублируем
      // в кэш текущей ревизии — следующий запуск попадёт точным ключом.
      const foreign = await getCompletedByHash(tenderId, stage, hash, scope);
      if (foreign) await saveCache(tenderId, stage, index, { findings: foreign, ...scope });
      return foreign;
    }),
    // Часть засчитана без обращения к модели (кэш ревизии или чекпойнт задачи) —
    // в истории прогона это видно отдельным source, а не выдаётся за расчёт.
    markReused: (index, count, source = SOURCE.CACHE) => guard(
      'reuse', () => markRunSegmentDone(runId, index, { count, source }),
    ),
    markRunning: (index) => guard('running', () => markRunSegmentRunning(runId, index)),
    saveSuccess: (index, findings) => guard('save', async () => {
      const list = Array.isArray(findings) ? findings : [];
      await saveCache(tenderId, stage, index, { findings: list, ...scope });
      await markRunSegmentDone(runId, index, { count: list.length, source: SOURCE.LLM });
    }),
    saveFailure: (index, error) => guard('fail', () => markRunSegmentFailed(runId, index, error)),
    finalize: (opts) => guard('finalize', () => finalizeRunSegments(runId, opts), { interrupted: 0, skipped: 0 }),
  };
}

module.exports = {
  STATUS,
  SOURCE,
  OPEN_STATUSES,
  // кэш
  planCache,
  pruneCache,
  getCompleted,
  getCompletedByHash,
  saveCache,
  invalidateCache,
  getCacheSegment,
  // история выполнения
  planRunSegments,
  markRunSegmentRunning,
  markRunSegmentDone,
  markRunSegmentFailed,
  finalizeRunSegments,
  listRunSegments,
  listSegmentRuns,
  latestRunIdWithSegments,
  summarize,
  makeStageSegmentStore,
};
