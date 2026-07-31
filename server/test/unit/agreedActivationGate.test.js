'use strict';

// Юнит-тесты гейта активации согласованной версии (activationGate) — без БД.
// Инварианты: unresolved_clusters = 0, carryovers_pending = 0,
// pipeline_stale = false, failed = conflicts = ambiguous = 0, skipped только
// с подтверждением инженера, база версии совпадает с текущей базой тендера.
// Запуск: npm run test:unit.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { assessActivation, countBlockingSkips } = require('../../services/agreedVersion/activationGate');

const READY = {
  pipeline_run_id: 'run-1',
  pipeline_stale: false,
  unresolved_clusters: 0,
  carryovers_pending: 0,
};

const CLEAN_REPORT = { applied: 3, skipped: 0, failed: 0, conflicts: 0, ambiguous: 0, noop: 1 };

const BASE_OK = {
  versionBase: { base_agreed_version_id: null, base_revision_id: 'rev-doc' },
  currentBase: { agreed_version_id: null, revision_id: 'rev-doc' },
};

function codes(assessment) {
  return assessment.violations.map((v) => v.code);
}

test('все инварианты соблюдены → активация разрешена', () => {
  const a = assessActivation({ readiness: READY, buildReport: CLEAN_REPORT, ...BASE_OK });
  assert.equal(a.ok, true);
  assert.equal(a.violations.length, 0);
});

test('нет активного pipeline-снимка → no_pipeline', () => {
  const a = assessActivation({
    readiness: { ...READY, pipeline_run_id: null }, buildReport: CLEAN_REPORT, ...BASE_OK,
  });
  assert.equal(a.ok, false);
  assert.ok(codes(a).includes('no_pipeline'));
});

test('устаревший снимок → pipeline_stale', () => {
  const a = assessActivation({
    readiness: { ...READY, pipeline_stale: true }, buildReport: CLEAN_REPORT, ...BASE_OK,
  });
  assert.ok(codes(a).includes('pipeline_stale'));
});

test('нерешённые кластеры → unresolved_clusters (с количеством)', () => {
  const a = assessActivation({
    readiness: { ...READY, unresolved_clusters: 10 }, buildReport: CLEAN_REPORT, ...BASE_OK,
  });
  const v = a.violations.find((x) => x.code === 'unresolved_clusters');
  assert.ok(v);
  assert.equal(v.count, 10);
});

test('неразобранный carry-over → carryovers_pending', () => {
  const a = assessActivation({
    readiness: { ...READY, carryovers_pending: 2 }, buildReport: CLEAN_REPORT, ...BASE_OK,
  });
  assert.ok(codes(a).includes('carryovers_pending'));
});

test('failed / conflicts / ambiguous в отчёте сборки блокируют по отдельности', () => {
  const failed = assessActivation({
    readiness: READY, buildReport: { ...CLEAN_REPORT, failed: 1 }, ...BASE_OK,
  });
  assert.ok(codes(failed).includes('failed_edits'));

  const conflicts = assessActivation({
    readiness: READY, buildReport: { ...CLEAN_REPORT, conflicts: 2 }, ...BASE_OK,
  });
  assert.ok(codes(conflicts).includes('conflicts'));

  const ambiguous = assessActivation({
    readiness: READY, buildReport: { ...CLEAN_REPORT, ambiguous: 1 }, ...BASE_OK,
  });
  assert.ok(codes(ambiguous).includes('ambiguous_targets'));
});

test('skipped без подтверждения блокирует, с подтверждением — проходит', () => {
  const report = { ...CLEAN_REPORT, skipped: 2 };
  const blocked = assessActivation({ readiness: READY, buildReport: report, ...BASE_OK });
  assert.ok(codes(blocked).includes('skipped_unconfirmed'));

  const confirmed = assessActivation({
    readiness: READY, buildReport: report, ...BASE_OK, confirmSkipped: true,
  });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.confirmed_skips, 2, 'подтверждённые пропуски видны для аудита');
});

test('countBlockingSkips считает только текст-меняющие решения (perDecision)', () => {
  const report = {
    skipped: 3, // суммарный счётчик врёт — источник истины perDecision
    perDecision: [
      { decision: 'edit', occurrences: [{ status: 'applied' }, { status: 'skipped_occurrence' }] },
      { decision: 'accept', occurrences: [{ status: 'skipped_occurrence' }] }, // защитный случай
      { decision: 'delete', occurrences: [{ status: 'skipped_occurrence' }] },
    ],
  };
  assert.equal(countBlockingSkips(report), 2);
});

test('база версии не совпадает с текущей базой → base_revision_mismatch', () => {
  // Версия строилась от оригинала, но активной стала другая версия.
  const chainMoved = assessActivation({
    readiness: READY, buildReport: CLEAN_REPORT,
    versionBase: { base_agreed_version_id: null, base_revision_id: 'rev-doc' },
    currentBase: { agreed_version_id: 'v2', revision_id: 'rev-v2' },
  });
  assert.ok(codes(chainMoved).includes('base_revision_mismatch'));

  // Та же база, но ревизия исходного документа изменилась (перезалит .md).
  const docChanged = assessActivation({
    readiness: READY, buildReport: CLEAN_REPORT,
    versionBase: { base_agreed_version_id: null, base_revision_id: 'rev-old' },
    currentBase: { agreed_version_id: null, revision_id: 'rev-new' },
  });
  assert.ok(codes(docChanged).includes('base_revision_mismatch'));
});

test('несколько нарушений копятся, а не перекрывают друг друга', () => {
  const a = assessActivation({
    readiness: { ...READY, unresolved_clusters: 1, pipeline_stale: true },
    buildReport: { ...CLEAN_REPORT, failed: 1, conflicts: 1, ambiguous: 1, skipped: 1 },
    versionBase: { base_agreed_version_id: null, base_revision_id: 'a' },
    currentBase: { agreed_version_id: null, revision_id: 'b' },
  });
  assert.equal(a.ok, false);
  const got = codes(a);
  for (const code of [
    'pipeline_stale', 'unresolved_clusters', 'failed_edits', 'conflicts',
    'ambiguous_targets', 'skipped_unconfirmed', 'base_revision_mismatch',
  ]) {
    assert.ok(got.includes(code), `нет нарушения ${code}`);
  }
});
