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

// Почему исход не зелёный — короткая причина из summary прогона для уведомления.
// Частичный QC Стадии 5 несёт её в summary.self_analysis (llm_status/llm_reason/
// failed_parts), добытчики 1–4 — в summary.segmentation.failed_parts.
function partialReason(run) {
  const s = (run && run.summary) || {};
  const sa = s.self_analysis || null;
  const fp = (sa && sa.failed_parts) || (s.segmentation && s.segmentation.failed_parts) || null;
  if (Array.isArray(fp) && fp.length) return `не досчитано частей ТЗ: ${fp.length}`;
  if (sa && sa.llm_reason) return sa.llm_reason;
  if (sa && sa.llm_status) return `LLM-QC: ${sa.llm_status}`;
  return 'часть замечаний не добыта';
}

function errorReason(status, run) {
  if (status === ANALYSIS_STATUS.CANCELLED) return 'прогон отменён';
  if (status === ANALYSIS_STATUS.INTERRUPTED) return 'прогон оборван (рестарт сервера или уход со страницы)';
  const s = (run && run.summary) || {};
  return s.error || 'см. логи';
}

// Уведомление по итогу фоновой стадии: severity + текст. Чистая функция —
// решение «зелёный / ЖЁЛТЫЙ / красный» живёт здесь, а не в store, и тестируется
// офлайн. Частичный итог обязан быть жёлтым: красная ошибка врёт (результат
// пригоден), зелёный успех врёт сильнее (итог неполон).
export function stageToast(stage, run) {
  const status = stageOutcome(run);
  const severity = severityOf(status);
  if (severity === 'success') {
    return { severity, status, message: `Стадия ${stage}: анализ завершён` };
  }
  if (severity === 'warning') {
    return {
      severity,
      status,
      message: `Стадия ${stage}: анализ завершён частично — ${partialReason(run)}. `
        + 'Проверьте части ТЗ и при необходимости пересчитайте.',
    };
  }
  return {
    severity,
    status,
    message: `Стадия ${stage}: анализ не удался — ${errorReason(status, run)}. Повторите запуск.`,
  };
}

// Можно ли запускать ПРОДАКШЕН-сборку конвейера (она переводит основной указатель
// и становится тем, что видит инженер). Правило: только когда добыты ВСЕ
// обязательные стадии и ни одна не кончилась ошибкой. После failed / cancelled /
// interrupted сборку не запускаем вовсе — иначе конвейер собрался бы из СТАРОГО
// активного снимка упавшей стадии, и портал показал бы «итог» вчерашней стадии
// как сегодняшний. Частичную сборку можно получить только явным debug-режимом
// (mode:'debug'), который указатель не двигает. Зеркало проверок manifest на
// сервере (services/pipeline/pipelineManifest.js).
export function checkProductionPipeline({ stageStatuses = [], aborted = null, requiredStages = 4 } = {}) {
  if (aborted === ANALYSIS_STATUS.CANCELLED) {
    return { allowed: false, reason: 'добыча замечаний отменена — сборка итога не запускалась' };
  }
  if (aborted === ANALYSIS_STATUS.INTERRUPTED) {
    return { allowed: false, reason: 'добыча замечаний прервана — сборка итога не запускалась' };
  }
  const bad = stageStatuses.findIndex((s) => severityOf(s) === 'error');
  if (bad >= 0) {
    return {
      allowed: false,
      reason: `шаг ${bad + 1} не завершён успешно — сборка итога не запускалась `
        + '(иначе итог собрался бы из прошлого результата этой стадии)',
    };
  }
  if (stageStatuses.length < requiredStages) {
    return {
      allowed: false,
      reason: `добыты не все стадии (${stageStatuses.length} из ${requiredStages}) — сборка итога не запускалась`,
    };
  }
  return { allowed: true, reason: null };
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
