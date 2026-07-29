'use strict';

// Состояние и гейты стадий: строка tender_stage_state (кто открыт / кто
// считается / кто завершён) + единый контракт исхода прогона.
// Вынесено из stageAnalysisEngine.js — движок отвечает за ПРОГОН стадии, этот
// модуль за её СТАТУС. Названия стадий (STAGE_LABELS) остаются в движке: он —
// единый источник (см. CLAUDE.md).

const db = require('../../db/connection');
const { stageScopeKey } = require('../jobs/jobModel');
const { STATUS } = require('../analysis/resultStatus');

// --- Единый контракт результата стадии (чистые функции, офлайн-тестируемы) ----

// Исход прогона стадии по строке analysis_runs → статус контракта (resultStatus).
// null-строка = прогона не было (стадия не досчитана) → interrupted; 'running'
// без живого процесса — тоже осиротевший прогон. Задание очереди может
// закончиться обрывом (рестарт/потеря воркера) или отменой инженера — такие
// прогоны пишутся своим статусом. Неизвестный статус — fail-closed.
// Контракт-статус из summary прогона (полный набор хранится там, а не в узкой
// колонке analysis_runs.status). summary — JSON-строка или уже разобранный объект.
function contractStatusFromSummary(run) {
  let s = run && run.summary;
  if (typeof s === 'string') {
    try { s = JSON.parse(s); } catch (_e) { return null; }
  }
  return (s && typeof s === 'object' && s.status) || null;
}

function classifyStageRun(run) {
  if (!run) return STATUS.INTERRUPTED;
  if (run.status === 'completed') {
    // completed в колонке может скрывать частичный результат (Стадия 5 QC):
    // полный контракт живёт в summary. Частичный → warning, а не success.
    return contractStatusFromSummary(run) === STATUS.COMPLETED_WITH_WARNINGS
      ? STATUS.COMPLETED_WITH_WARNINGS
      : STATUS.COMPLETED;
  }
  if (run.status === 'failed') return STATUS.FAILED;
  if (run.status === 'running') return STATUS.INTERRUPTED;
  if (run.status === STATUS.INTERRUPTED) return STATUS.INTERRUPTED;
  if (run.status === STATUS.CANCELLED) return STATUS.CANCELLED;
  return STATUS.FAILED;
}

// Завершать (finish) стадию можно ТОЛЬКО из 'reviewing' — этот статус выставляет
// лишь успешный runStageInner. Сбойный прогон возвращает статус в 'open'
// (releaseRunningStage в finalizeStageRun), поэтому провалившуюся стадию
// завершить нельзя.
function canFinishStage(status) {
  return status === 'reviewing';
}

function isStageRunnable(state, stage) {
  if (stage === 1) return ['open', 'running', 'reviewing'].includes(state.stage1_status);
  const prevKey = `stage${stage - 1}_status`;
  if (state[prevKey] !== 'finished') return false;
  const cur = state[`stage${stage}_status`];
  return cur !== 'finished';
}

// --- DB-обвязка ----------------------------------------------------------------

async function getStageState(tenderId) {
  let state = await db.queryOne('SELECT * FROM tender_stage_state WHERE tender_id = ?', tenderId);
  if (!state) {
    await db.queryRun(
      `
      INSERT INTO tender_stage_state (tender_id, current_stage, stage1_status, stage2_status, stage3_status, stage4_status, stage5_status)
      VALUES (?, 1, 'open', 'locked', 'locked', 'locked', 'locked')
    `,
      tenderId,
    );
    state = await db.queryOne('SELECT * FROM tender_stage_state WHERE tender_id = ?', tenderId);
  }
  return state;
}

async function setStageStatus(tenderId, stage, status, runner = db) {
  const col = `stage${stage}_status`;
  await runner.queryRun(
    `UPDATE tender_stage_state SET ${col} = ?, current_stage = ? WHERE tender_id = ?`,
    status,
    stage,
    tenderId,
  );
}

// Допустимые значения tender_stage_state.stageN_status.
const STAGE_STATUSES = Object.freeze(['locked', 'open', 'running', 'reviewing', 'finished']);

function lifecycleError(message, code = 'STAGE_LIFECYCLE_CONFLICT', status = 409) {
  const err = new Error(`Переход статуса стадии не выполнен: ${message}`);
  err.code = code;
  err.status = status;
  err.retryable = false;
  return err;
}

// УСЛОВНЫЙ перевод статуса стадии: from → to, ровно для этого тендера и этой
// стадии. В отличие от setStageStatus (безусловный UPDATE) здесь три вещи:
//   • ожидаемый ПРЕДЫДУЩИЙ статус стоит в WHERE — параллельный процесс, уже
//     уведший стадию дальше, не будет перетёрт;
//   • rowCount проверяется: 0 строк = состояние не то, которое мы предполагали,
//     это конфликт жизненного цикла, а не «ничего не поменялось»;
//   • tx (опц.) — перевод идёт транзакцией вызывающего, поэтому до её коммита
//     стадия для читателей остаётся в прежнем статусе.
async function transitionStageStatus(tenderId, stage, { from, to, tx = null } = {}) {
  if (!tenderId) throw lifecycleError('не передан tenderId', 'STAGE_TRANSITION_INVALID', 500);
  if (!Number.isInteger(stage) || stage < 1 || stage > 5) {
    throw lifecycleError(`недопустимая стадия «${stage}»`, 'STAGE_TRANSITION_INVALID', 500);
  }
  if (!STAGE_STATUSES.includes(from) || !STAGE_STATUSES.includes(to)) {
    throw lifecycleError(
      `недопустимый переход «${from}» → «${to}»`, 'STAGE_TRANSITION_INVALID', 500,
    );
  }
  const runner = tx || db;
  const col = `stage${stage}_status`;
  const res = await runner.queryRun(
    `UPDATE tender_stage_state SET ${col} = ?, current_stage = ?
      WHERE tender_id = ? AND ${col} = ?`,
    to, stage, tenderId, from,
  );
  const changed = (res && (res.changes ?? res.rowCount)) || 0;
  if (changed !== 1) {
    throw lifecycleError(
      `тендер ${tenderId}, стадия ${stage}: ожидался статус «${from}» для перехода в «${to}», `
        + `обновлено строк: ${changed}`,
    );
  }
  return { tender_id: tenderId, stage, from, to, changed };
}

async function unlockNextStage(tenderId, stage, runner = db) {
  if (stage >= 5) return;
  const nextCol = `stage${stage + 1}_status`;
  await runner.queryRun(
    `UPDATE tender_stage_state SET ${nextCol} = 'open', current_stage = ? WHERE tender_id = ?`,
    stage + 1,
    tenderId,
  );
}

// Вернуть стадию из 'running' в исходный статус. Условно: если стадия уже ушла
// в 'reviewing' (успех) или 'finished', трогать её нельзя.
async function releaseRunningStage(tenderId, stage, prevStatus = 'open') {
  const res = await db.queryRun(
    `UPDATE tender_stage_state SET stage${stage}_status = ?, current_stage = ?
      WHERE tender_id = ? AND stage${stage}_status = 'running'`,
    prevStatus === 'running' ? 'open' : prevStatus,
    stage,
    tenderId,
  );
  return (res && (res.changes ?? res.rowCount)) || 0;
}

// Авто-починка «зомби»-статусов на старте сервера. Раньше фоновый прогон жил в
// памяти процесса, поэтому на старте ЛЮБОЙ 'running' считался осиротевшим и
// сбрасывался. Теперь прогоны в очереди, и это правило стало неверным: чужой
// живой воркер продолжает считать стадию, пока API-процесс перезапускается.
// Сбрасываем только те стадии, у которых НЕТ живого задания в очереди —
// остальные доведёт воркер (или reaper пометит их задачи interrupted).
// Issues не трогаем: успешный прогон пишет их только в финальной транзакции.
async function recoverOrphanedRunningStages() {
  let recovered = 0;
  for (let s = 1; s <= 5; s += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await db.queryRun(
      `UPDATE tender_stage_state st
          SET stage${s}_status = 'open'
        WHERE st.stage${s}_status = 'running'
          AND NOT EXISTS (
            SELECT 1 FROM analysis_jobs j
             WHERE j.tender_id = st.tender_id
               AND j.scope_key = ?
               AND j.status IN ('queued', 'running'))`,
      stageScopeKey(s),
    );
    recovered += (res && (res.changes ?? res.rowCount)) || 0;
  }
  if (recovered) {
    // eslint-disable-next-line no-console
    console.log(`[stageEngine] восстановлено осиротевших 'running'-стадий: ${recovered} → 'open'`);
  }
  return recovered;
}

module.exports = {
  STAGE_STATUSES,
  // чистые функции контракта результата (офлайн-тесты)
  classifyStageRun,
  canFinishStage,
  isStageRunnable,
  // DB
  getStageState,
  setStageStatus,
  transitionStageStatus,
  unlockNextStage,
  releaseRunningStage,
  recoverOrphanedRunningStages,
};
