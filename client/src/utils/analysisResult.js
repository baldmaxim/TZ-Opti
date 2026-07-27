// Клиентское зеркало серверного контракта результата анализа.
// Источник истины — server/services/analysis/resultStatus.js: статусы, severity
// и правила aggregateRun/stageOutcome должны совпадать (как пара STAGE_META ↔
// STAGE_LABELS). Меняешь там — правь и здесь.

export const ANALYSIS_STATUS = Object.freeze({
  COMPLETED: 'completed', // полный успех — собран весь итог
  COMPLETED_WITH_WARNINGS: 'completed_with_warnings', // частичный результат
  FAILED: 'failed', // сбой — пригодного результата нет
  CANCELLED: 'cancelled', // прервано пользователем / гейт не пустил
  INTERRUPTED: 'interrupted', // прогон оборван (уход со страницы, рестарт)
});

// success — зелёный (только полный успех), warning — жёлтый (частичный),
// error — красный (любой недосчёт).
const SEVERITY = {
  [ANALYSIS_STATUS.COMPLETED]: 'success',
  [ANALYSIS_STATUS.COMPLETED_WITH_WARNINGS]: 'warning',
  [ANALYSIS_STATUS.FAILED]: 'error',
  [ANALYSIS_STATUS.CANCELLED]: 'error',
  [ANALYSIS_STATUS.INTERRUPTED]: 'error',
};

// Неизвестный статус → ошибка (fail-closed).
export function severityOf(status) {
  return SEVERITY[status] || 'error';
}

// Исход прогона стадии по строке из /stages. Зеркало classifyStageRun на сервере:
// узкая колонка analysis_runs.status ('completed'|'failed'|'running'|'cancelled'|
// 'interrupted') + полный контракт в разобранном summary (run.summary.status),
// где живёт completed_with_warnings (частичный QC Стадии 5).
export function stageOutcome(run) {
  if (!run) return ANALYSIS_STATUS.INTERRUPTED;
  if (run.status === 'completed') {
    const contract = run.summary && run.summary.status;
    return contract === ANALYSIS_STATUS.COMPLETED_WITH_WARNINGS
      ? ANALYSIS_STATUS.COMPLETED_WITH_WARNINGS
      : ANALYSIS_STATUS.COMPLETED;
  }
  if (run.status === 'failed') return ANALYSIS_STATUS.FAILED;
  if (run.status === 'running') return ANALYSIS_STATUS.INTERRUPTED;
  if (run.status === ANALYSIS_STATUS.CANCELLED) return ANALYSIS_STATUS.CANCELLED;
  if (run.status === ANALYSIS_STATUS.INTERRUPTED) return ANALYSIS_STATUS.INTERRUPTED;
  return ANALYSIS_STATUS.FAILED;
}

// Свести исход целого прогона «Анализ ТЗ». Зеркало aggregateRun на сервере.
// Success — только когда добыты ВСЕ стадии и сборка кластеров прошла полностью.
export function aggregateRun({ stageStatuses = [], pipelineStatus = null, aborted = null } = {}) {
  if (aborted === ANALYSIS_STATUS.CANCELLED || aborted === ANALYSIS_STATUS.INTERRUPTED) return aborted;
  if (
    pipelineStatus !== ANALYSIS_STATUS.COMPLETED &&
    pipelineStatus !== ANALYSIS_STATUS.COMPLETED_WITH_WARNINGS
  ) {
    return ANALYSIS_STATUS.FAILED;
  }
  const anyStageBad = stageStatuses.some((s) => s !== ANALYSIS_STATUS.COMPLETED);
  if (pipelineStatus === ANALYSIS_STATUS.COMPLETED_WITH_WARNINGS || anyStageBad) {
    return ANALYSIS_STATUS.COMPLETED_WITH_WARNINGS;
  }
  return ANALYSIS_STATUS.COMPLETED;
}
