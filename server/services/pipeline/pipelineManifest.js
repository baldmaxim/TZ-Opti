'use strict';

// MANIFEST ВХОДОВ КОНВЕЙЕРА — чистое ядро атомарности сборки.
//
// Конвейер (draft_issues → critic → clustering → self-analysis) собирается НЕ
// «из того, что лежит в БД», а из ТОЧНОГО НАБОРА stage-прогонов, зафиксированного
// в момент старта. Manifest — этот набор: на каждую обязательную стадию
//   • номер стадии            (stage)
//   • analysis_run_id         (какой именно снимок стадии взят)
//   • documents_revision_id   (по какой ревизии документов он посчитан)
//   • config_version          (с какой версией промтов/модели)
//   • статус прогона          (status: должен быть completed)
// плюс ревизия документов и версия конфигурации всего прогона.
//
// Зачем: без manifest сборка «подхватывала» старый АКТИВНЫЙ прогон стадии, если
// новый прогон этой стадии упал/был отменён/оборван — портал показывал итог,
// собранный из вчерашней стадии 3 и сегодняшних 1–2, и никто этого не видел.
// Manifest делает набор входов явным, а две проверки (перед шагами и ПЕРЕД
// АКТИВАЦИЕЙ) — атомарность: если во время сборки указатель стадии сдвинулся или
// документы перезалили, снимок НЕ активируется (stale pipeline).
//
// Режимы: production (по умолчанию) требует полный валидный набор и переводит
// указатель; debug — явный режим частичной сборки, который указатель НЕ трогает.

// Обязательные входы: стадии-добытчики. Стадия 5 (QC) — сам шаг конвейера, не вход.
const REQUIRED_STAGES = Object.freeze([1, 2, 3, 4]);

const MODE = Object.freeze({
  PRODUCTION: 'production', // полный валидный набор входов + перевод указателя
  DEBUG: 'debug', // частичная сборка, указатель НЕ двигается
});

const MANIFEST_VERSION = 1;

// Коды нарушений. Первые пять — про сам набор входов (проверка до шагов),
// последние три — про изменение состояния ВО ВРЕМЯ сборки (проверка до активации).
const VIOLATION = Object.freeze({
  STAGE_RUN_MISSING: 'stage_run_missing', // нет снимка стадии (не запускалась / указатель снят)
  STAGE_RUN_NOT_COMPLETED: 'stage_run_not_completed', // failed | cancelled | interrupted | running
  STAGE_POINTER_STALE: 'stage_pointer_stale', // есть НОВЕЕ прогон стадии, а указатель на старом
  STAGE_REVISION_MISMATCH: 'stage_revision_mismatch', // стадия посчитана по другой ревизии документов
  STAGE_REVISION_UNKNOWN: 'stage_revision_unknown', // ревизия стадии неизвестна (легаси-прогон)
  STAGE_POINTER_MOVED: 'stage_pointer_moved', // во время сборки указатель стадии сменился
  STAGE_RUN_SUPERSEDED: 'stage_run_superseded', // взятый снимок стадии архивирован
  DOCUMENTS_REVISION_CHANGED: 'documents_revision_changed', // документы перезалили во время сборки
});

// Только явное 'debug' включает частичный режим — опечатка/лишний флаг не должны
// незаметно отключить проверки (fail-closed к production).
function resolveMode(opts = {}) {
  const raw = typeof opts === 'string' ? opts : (opts && opts.mode);
  return String(raw || '').trim().toLowerCase() === MODE.DEBUG ? MODE.DEBUG : MODE.PRODUCTION;
}

const isDebug = (mode) => resolveMode({ mode }) === MODE.DEBUG;

// Нормализация одной записи входа стадии (то, что отдаёт collectStageInputs).
//   { stage, active_run_id, latest_run_id, run: { id, status, documents_revision_id,
//     config_version, superseded_at } | null }
function stageEntry(input, stage) {
  const run = (input && input.run) || null;
  const activeId = (input && input.active_run_id) || (run && run.id) || null;
  const latestId = (input && input.latest_run_id) || null;
  return {
    stage,
    analysis_run_id: activeId,
    documents_revision_id: (run && run.documents_revision_id) || null,
    config_version: (run && run.config_version) || null,
    status: (run && run.status) || null,
    // Указатель стадии показывает на САМЫЙ СВЕЖИЙ её прогон? false = после этого
    // снимка стадию гоняли снова и прогон не стал актуальным (упал/оборван/идёт).
    is_latest: Boolean(activeId) && (!latestId || latestId === activeId),
    superseded: Boolean(run && run.superseded_at),
  };
}

// Manifest — ЗАПИСЬ фактического набора входов на момент старта (не приговор).
// Судит его verifyInputsManifest: manifest фиксирует даже дырявый набор, чтобы в
// отчёте было видно, ЧТО именно взяли (или чего не хватило).
function buildInputsManifest({
  stageInputs = [],
  documentsRevisionId = null,
  configVersion = null,
  mode = MODE.PRODUCTION,
  requiredStages = REQUIRED_STAGES,
  capturedAt = null,
} = {}) {
  const byStage = new Map((stageInputs || []).map((s) => [Number(s && s.stage), s]));
  return {
    version: MANIFEST_VERSION,
    mode: resolveMode({ mode }),
    captured_at: capturedAt,
    documents_revision_id: documentsRevisionId,
    config_version: configVersion,
    required_stages: [...requiredStages],
    stages: requiredStages.map((stage) => stageEntry(byStage.get(Number(stage)), Number(stage))),
  };
}

function violation(code, stage, message, extra = {}) {
  return { code, stage: stage ?? null, message, ...extra };
}

// Проверка набора входов (до шагов) и — с current — его неизменности (до активации).
//   manifest — зафиксированный при старте набор;
//   stageInputs — АКТУАЛЬНОЕ состояние указателей/прогонов стадий (опц.);
//   documentsRevisionId — АКТУАЛЬНАЯ ревизия документов (опц.).
// Возвращает { ok, violations[], mode, phase }. Пустой manifest — нарушение
// (fail-closed): сборка без зафиксированных входов не считается валидной.
function verifyInputsManifest(manifest, { stageInputs = null, documentsRevisionId = null, phase = 'begin' } = {}) {
  const violations = [];
  if (!manifest || !Array.isArray(manifest.stages)) {
    return {
      ok: false,
      phase,
      mode: MODE.PRODUCTION,
      violations: [violation('manifest_missing', null, 'Manifest входов конвейера не зафиксирован')],
    };
  }
  const mode = resolveMode({ mode: manifest.mode });
  const expectedRevision = manifest.documents_revision_id || null;
  const required = Array.isArray(manifest.required_stages) && manifest.required_stages.length
    ? manifest.required_stages
    : REQUIRED_STAGES;
  const byStage = new Map(manifest.stages.map((s) => [Number(s.stage), s]));
  const currentByStage = stageInputs
    ? new Map((stageInputs || []).map((s) => [Number(s && s.stage), s]))
    : null;

  for (const stageRaw of required) {
    const stage = Number(stageRaw);
    const entry = byStage.get(stage);
    if (!entry || !entry.analysis_run_id) {
      violations.push(violation(VIOLATION.STAGE_RUN_MISSING, stage,
        `Стадия ${stage}: нет снимка (прогон не выполнен или указатель снят)`));
      continue;
    }
    if (entry.status !== 'completed') {
      violations.push(violation(VIOLATION.STAGE_RUN_NOT_COMPLETED, stage,
        `Стадия ${stage}: прогон не завершён успешно (статус «${entry.status || '—'}»)`,
        { analysis_run_id: entry.analysis_run_id, actual: entry.status || null }));
    }
    // Ключевой инвариант задачи: старый актуальный прогон стадии НЕ подставляется
    // молча вместо нового неуспешного (упавшего/отменённого/оборванного).
    if (entry.is_latest === false) {
      violations.push(violation(VIOLATION.STAGE_POINTER_STALE, stage,
        `Стадия ${stage}: есть более новый прогон, но актуальным остался прежний — `
        + 'новый прогон не завершился успешно; повторите стадию, а не собирайте итог из старого снимка',
        { analysis_run_id: entry.analysis_run_id }));
    }
    if (entry.superseded) {
      violations.push(violation(VIOLATION.STAGE_RUN_SUPERSEDED, stage,
        `Стадия ${stage}: взятый снимок архивирован (superseded)`,
        { analysis_run_id: entry.analysis_run_id }));
    }
    if (!entry.documents_revision_id) {
      violations.push(violation(VIOLATION.STAGE_REVISION_UNKNOWN, stage,
        `Стадия ${stage}: ревизия документов снимка неизвестна — пересчитайте стадию`,
        { analysis_run_id: entry.analysis_run_id }));
    } else if (expectedRevision && entry.documents_revision_id !== expectedRevision) {
      violations.push(violation(VIOLATION.STAGE_REVISION_MISMATCH, stage,
        `Стадия ${stage}: снимок посчитан по другой ревизии документов`,
        {
          analysis_run_id: entry.analysis_run_id,
          expected: expectedRevision,
          actual: entry.documents_revision_id,
        }));
    }
    // Сдвиг во время сборки (проверка перед активацией).
    if (currentByStage) {
      const now = stageEntry(currentByStage.get(stage), stage);
      if (now.analysis_run_id !== entry.analysis_run_id) {
        violations.push(violation(VIOLATION.STAGE_POINTER_MOVED, stage,
          `Стадия ${stage}: во время сборки актуальный снимок сменился — итог собран из устаревших входов`,
          { expected: entry.analysis_run_id, actual: now.analysis_run_id }));
      } else if (now.superseded) {
        violations.push(violation(VIOLATION.STAGE_RUN_SUPERSEDED, stage,
          `Стадия ${stage}: снимок архивирован во время сборки`,
          { analysis_run_id: entry.analysis_run_id }));
      }
    }
  }

  if (documentsRevisionId && expectedRevision && documentsRevisionId !== expectedRevision) {
    violations.push(violation(VIOLATION.DOCUMENTS_REVISION_CHANGED, null,
      'Ревизия документов тендера изменилась во время сборки — итог относится к прежним документам',
      { expected: expectedRevision, actual: documentsRevisionId }));
  }

  return { ok: violations.length === 0, phase, mode, violations };
}

// Короткое человекочитаемое объяснение (для сообщения об отказе и отчёта).
function describeViolations(violations) {
  const list = (violations || []).map((v) => v.message).filter(Boolean);
  if (!list.length) return 'входы конвейера в порядке';
  return list.join('; ');
}

// Пригодность набора входов к ПРОДАКШЕН-сборке: только полный валидный набор.
// debug-режим допускает нарушения, но взамен не двигает указатель — решение
// «активировать или нет» принимает finalize по этому же признаку.
function canActivate(verification) {
  return Boolean(verification && verification.ok && verification.mode === MODE.PRODUCTION);
}

module.exports = {
  REQUIRED_STAGES,
  MODE,
  MANIFEST_VERSION,
  VIOLATION,
  resolveMode,
  isDebug,
  stageEntry,
  buildInputsManifest,
  verifyInputsManifest,
  describeViolations,
  canActivate,
};
