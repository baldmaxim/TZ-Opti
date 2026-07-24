'use strict';

// Единый контракт результата анализа: один набор статусов на все слои прогона
// «Анализ ТЗ» (стадия-добытчик 1–4, оркестратор конвейера, общий прогон). Нужен,
// чтобы портал не показывал success после сбоя стадии или конвейера.
//
// Клиентское зеркало — client/src/utils/analysisResult.js: статусы, severity и
// правила aggregateRun/stageOutcome должны совпадать с этим файлом (как пара
// STAGE_LABELS ↔ STAGE_META). Меняешь здесь — правь и там.

// Статусы результата (в БД analysis_runs.status по-прежнему хранится узкий набор
// 'completed'|'failed'|'running'; полный контракт — в summary и на уровне прогона).
const STATUS = Object.freeze({
  COMPLETED: 'completed', // полный успех — собран весь итог
  COMPLETED_WITH_WARNINGS: 'completed_with_warnings', // частичный результат (что-то добыто, но не всё)
  FAILED: 'failed', // сбой — пригодного результата нет
  CANCELLED: 'cancelled', // прервано пользователем / гейт не пустил запуск
  INTERRUPTED: 'interrupted', // прогон оборван (рестарт сервера, уход со страницы, осиротевший 'running')
});

const ALL_STATUSES = Object.freeze(Object.values(STATUS));

// Как показывать статус в UI. success — зелёный (только полный успех),
// warning — жёлтый (частичный результат), error — красный (любой недосчёт).
const SEVERITY = Object.freeze({
  [STATUS.COMPLETED]: 'success',
  [STATUS.COMPLETED_WITH_WARNINGS]: 'warning',
  [STATUS.FAILED]: 'error',
  [STATUS.CANCELLED]: 'error',
  [STATUS.INTERRUPTED]: 'error',
});

// Неизвестный статус трактуем как ошибку (fail-closed): лучше показать красный,
// чем случайно отрапортовать успех.
function severityOf(status) {
  return SEVERITY[status] || 'error';
}

const isSuccess = (status) => severityOf(status) === 'success';
const isWarning = (status) => severityOf(status) === 'warning';
const isError = (status) => severityOf(status) === 'error';

// Свести исход целого прогона «Анализ ТЗ» из исходов его частей.
//   stageStatuses — статусы прогонов добытчиков стадий 1–4 (STATUS.*);
//   pipelineStatus — статус сборки кластеров (STATUS.* или null, если не дошли);
//   aborted — STATUS.CANCELLED | STATUS.INTERRUPTED, если прогон оборван до сборки.
// Success — только когда добыты ВСЕ стадии и сборка прошла полностью.
function aggregateRun({ stageStatuses = [], pipelineStatus = null, aborted = null } = {}) {
  if (aborted === STATUS.CANCELLED || aborted === STATUS.INTERRUPTED) return aborted;
  // Сборка кластеров — обязательный финал: без неё итог не собран.
  if (pipelineStatus !== STATUS.COMPLETED && pipelineStatus !== STATUS.COMPLETED_WITH_WARNINGS) {
    return STATUS.FAILED;
  }
  const anyStageBad = stageStatuses.some((s) => s !== STATUS.COMPLETED);
  if (pipelineStatus === STATUS.COMPLETED_WITH_WARNINGS || anyStageBad) {
    return STATUS.COMPLETED_WITH_WARNINGS;
  }
  return STATUS.COMPLETED;
}

module.exports = {
  STATUS,
  ALL_STATUSES,
  SEVERITY,
  severityOf,
  isSuccess,
  isWarning,
  isError,
  aggregateRun,
};
