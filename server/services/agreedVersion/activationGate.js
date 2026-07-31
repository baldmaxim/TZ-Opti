'use strict';

// ЧИСТОЕ ядро гейта активации согласованной версии (без БД, офлайн-тесты).
//
// Активация делает версию ВХОДОМ следующего раунда анализа и базой экспорта —
// активировать можно только версию, которая ПОЛНОСТЬЮ и ОДНОЗНАЧНО
// материализует завершённую рецензию. Инварианты:
//   • unresolved_clusters = 0 и carryovers_pending = 0 (рецензия завершена);
//   • pipeline_stale = false (снимок собран по текущей ревизии документов);
//   • build_report: failed = 0, conflicts = 0, ambiguous = 0 — каждая правка
//     легла в текст ровно туда, куда решил инженер;
//   • skipped > 0 (вхождение текст-меняющего решения не найдено дословно)
//     допустим ТОЛЬКО после явного подтверждения инженера (confirmSkipped);
//     решения, не меняющие текст (accept/reject), skipped не порождают;
//   • база версии совпадает с текущей базой тендера: версия строилась от
//     того же текста, поверх которого встанет (base_agreed_version_id +
//     base_revision_id).
//
// Нарушения НЕ исключают активацию навсегда: отдельный форс-режим
// («активировать неполную версию с отклонением от инвариантов») требует
// основание и пишет отдельное событие аудита — это решает СЕРВИС
// (activateVersion), ядро только называет нарушения.

const { TEXT_CHANGING } = require('./agreedTextBuilder');

// skipped-вхождения ТОЛЬКО текст-меняющих решений. Предпочитаем perDecision
// (точный подсчёт); без него — суммарный счётчик отчёта (по построению билдера
// skipped порождают только текст-меняющие решения).
function countBlockingSkips(buildReport) {
  const report = buildReport || {};
  if (Array.isArray(report.perDecision)) {
    let n = 0;
    for (const dec of report.perDecision) {
      if (!TEXT_CHANGING.has(dec.decision)) continue;
      for (const occ of dec.occurrences || []) {
        if (occ.status === 'skipped_occurrence') n += 1;
      }
    }
    return n;
  }
  return Number(report.skipped || 0);
}

// readiness — отчёт reviewReadinessService.getReadiness;
// buildReport — build_report версии; versionBase — строка версии
// ({base_agreed_version_id, base_revision_id}); currentBase — текущая база
// тендера ({agreed_version_id, revision_id}); confirmSkipped — явное
// подтверждение инженером пропущенных вхождений.
function assessActivation({
  readiness = null,
  buildReport = null,
  versionBase = {},
  currentBase = {},
  confirmSkipped = false,
} = {}) {
  const violations = [];
  const push = (code, message, count) => {
    const v = { code, message };
    if (count != null) v.count = count;
    violations.push(v);
  };

  const r = readiness || {};
  if (!r.pipeline_run_id) {
    push('no_pipeline', 'итог анализа не собран (нет активного снимка конвейера)');
  }
  if (r.pipeline_stale) {
    push('pipeline_stale', 'снимок анализа собран по прежней ревизии документов');
  }
  const unresolved = Number(r.unresolved_clusters || 0);
  if (unresolved > 0) {
    push('unresolved_clusters', `рецензия не завершена: без решения ${unresolved} замечаний`, unresolved);
  }
  const carry = Number(r.carryovers_pending || 0);
  if (carry > 0) {
    push('carryovers_pending', `не разобран перенос решений прошлого прогона: ${carry}`, carry);
  }

  const report = buildReport || {};
  const failed = Number(report.failed || 0);
  if (failed > 0) push('failed_edits', `правки не легли в текст (фрагмент не найден): ${failed}`, failed);
  const conflicts = Number(report.conflicts || 0);
  if (conflicts > 0) push('conflicts', `пересечения правок (конфликты мест): ${conflicts}`, conflicts);
  const ambiguous = Number(report.ambiguous || 0);
  if (ambiguous > 0) push('ambiguous_targets', `неоднозначные цели правок (несколько мест): ${ambiguous}`, ambiguous);
  const skipped = countBlockingSkips(report);
  if (skipped > 0 && !confirmSkipped) {
    push('skipped_unconfirmed', `пропущенные вхождения текст-меняющих решений без подтверждения инженера: ${skipped}`, skipped);
  }

  const expectedVersionId = versionBase.base_agreed_version_id || null;
  const actualVersionId = currentBase.agreed_version_id || null;
  const expectedRevision = versionBase.base_revision_id || null;
  const actualRevision = currentBase.revision_id || null;
  if (expectedVersionId !== actualVersionId || expectedRevision !== actualRevision) {
    push('base_revision_mismatch', 'база версии не совпадает с текущей базой тендера — версия строилась от другого текста');
  }

  return {
    ok: violations.length === 0,
    violations,
    confirmed_skips: skipped > 0 && confirmSkipped ? skipped : 0,
  };
}

module.exports = { assessActivation, countBlockingSkips };
