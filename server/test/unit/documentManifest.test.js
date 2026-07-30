'use strict';

// Манифест тендерного пакета — чистое ядро (services/documents/manifestModel):
// выбор актуальных документов (статус / приоритет / дата / замена), валидация
// PATCH-полей, цепочки замены и вклад манифеста в ревизию набора документов.
// Запуск: npm run test:unit.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  annotateDocuments,
  selectActiveDocuments,
  pickPrimaryDocument,
  normalizeManifestPatch,
  validateSupersedes,
  buildManifest,
  manifestRevisionSuffix,
} = require('../../services/documents/manifestModel');

const doc = (id, over = {}) => ({
  id,
  doc_type: 'vor',
  name: `${id}.xlsx`,
  uploaded_at: '2026-07-01T00:00:00.000Z',
  actuality_status: 'actual',
  revision_label: null,
  doc_date: null,
  conflict_priority: null,
  applicability: null,
  supersedes_document_id: null,
  ...over,
});

// --- Выбор актуальных документов ---------------------------------------------

test('superseded по собственному статусу исключается из выбора', () => {
  const docs = [doc('a'), doc('b', { actuality_status: 'superseded' })];
  assert.deepEqual(selectActiveDocuments(docs, 'vor').map((d) => d.id), ['a']);
});

test('обратная ссылка замены выключает документ, даже если его статус не обновили', () => {
  // b заявляет «заменяю a» — a остаётся actual в своей строке, но эффективно superseded.
  const docs = [doc('a'), doc('b', { supersedes_document_id: 'a' })];
  const active = selectActiveDocuments(docs, 'vor');
  assert.deepEqual(active.map((d) => d.id), ['b']);
  const annotated = annotateDocuments(docs);
  assert.equal(annotated.find((d) => d.id === 'a').manifest_status, 'superseded');
  assert.deepEqual(annotated.find((d) => d.id === 'a').superseded_by, ['b']);
});

test('informational уступает actual независимо от даты загрузки', () => {
  const docs = [
    doc('rd', { actuality_status: 'informational', uploaded_at: '2026-07-20T00:00:00.000Z' }),
    doc('pd', { uploaded_at: '2026-07-01T00:00:00.000Z' }),
  ];
  assert.deepEqual(selectActiveDocuments(docs, 'vor').map((d) => d.id), ['pd', 'rd']);
});

test('порядок: приоритет при противоречии → дата документа → дата загрузки', () => {
  const docs = [
    doc('late', { uploaded_at: '2026-07-25T00:00:00.000Z' }),
    doc('dated', { doc_date: '2026-07-10', uploaded_at: '2026-07-01T00:00:00.000Z' }),
    doc('prio', { conflict_priority: 5, uploaded_at: '2026-06-01T00:00:00.000Z' }),
  ];
  assert.deepEqual(selectActiveDocuments(docs, 'vor').map((d) => d.id), ['prio', 'dated', 'late']);
});

test('несколько актуальных ВОР сосуществуют (корпус 1 + корпус 2)', () => {
  const docs = [
    doc('k1', { applicability: 'корпус 1' }),
    doc('k2', { applicability: 'корпус 2', uploaded_at: '2026-07-02T00:00:00.000Z' }),
  ];
  assert.equal(selectActiveDocuments(docs, 'vor').length, 2);
});

test('pickPrimaryDocument с match выбирает md-копию ТЗ, а не последний файл слота', () => {
  const docs = [
    doc('tz-docx', { doc_type: 'tz', name: 'ТЗ.docx', uploaded_at: '2026-07-20T00:00:00.000Z' }),
    doc('tz-md', { doc_type: 'tz', name: 'ТЗ.md', uploaded_at: '2026-07-01T00:00:00.000Z' }),
  ];
  const md = pickPrimaryDocument(docs, 'tz', { match: /\.md$/i });
  assert.equal(md.id, 'tz-md');
});

// --- Валидация PATCH ----------------------------------------------------------

test('normalizeManifestPatch: неизвестное поле — ошибка, а не молчаливое игнорирование', () => {
  const { errors } = normalizeManifestPatch({ revsion_label: 'опечатка' });
  assert.equal(errors.length, 1);
});

test('normalizeManifestPatch: кривые статус / дата / приоритет отклоняются', () => {
  assert.ok(normalizeManifestPatch({ actuality_status: 'main' }).errors.length);
  assert.ok(normalizeManifestPatch({ doc_date: '20.07.2026' }).errors.length);
  assert.ok(normalizeManifestPatch({ conflict_priority: 'высокий' }).errors.length);
  assert.ok(normalizeManifestPatch({ conflict_priority: 1.5 }).errors.length);
});

test('normalizeManifestPatch: пустые значения сбрасывают поле (null), статус — в actual', () => {
  const { value, errors } = normalizeManifestPatch({
    revision_label: '', doc_date: null, conflict_priority: '', actuality_status: '',
    supersedes_document_id: '',
  });
  assert.deepEqual(errors, []);
  assert.equal(value.revision_label, null);
  assert.equal(value.doc_date, null);
  assert.equal(value.conflict_priority, null);
  assert.equal(value.actuality_status, 'actual');
  assert.equal(value.supersedes_document_id, null);
});

test('normalizeManifestPatch: корректные значения нормализуются', () => {
  const { value, errors } = normalizeManifestPatch({
    revision_label: ' редакция 3 ', actuality_status: 'Informational',
    doc_date: '2026-07-15', conflict_priority: '10', applicability: 'корпус 2',
  });
  assert.deepEqual(errors, []);
  assert.equal(value.revision_label, 'редакция 3');
  assert.equal(value.actuality_status, 'informational');
  assert.equal(value.conflict_priority, 10);
});

// --- Цепочки замены -----------------------------------------------------------

test('validateSupersedes: самозамена и несуществующая цель запрещены', () => {
  const docs = [doc('a'), doc('b')];
  assert.ok(validateSupersedes(docs, 'a', 'a'));
  assert.ok(validateSupersedes(docs, 'a', 'ghost'));
  assert.equal(validateSupersedes(docs, 'b', 'a'), null);
});

test('validateSupersedes: цикл замены обнаруживается по всей цепочке', () => {
  // c → b уже записано, b → a уже записано; попытка a → c замкнула бы кольцо.
  const docs = [
    doc('a'),
    doc('b', { supersedes_document_id: 'a' }),
    doc('c', { supersedes_document_id: 'b' }),
  ];
  assert.ok(validateSupersedes(docs, 'a', 'c'));
});

// --- Сборка манифеста ---------------------------------------------------------

test('buildManifest: группы по типам, superseded в конце группы, предупреждения о разметке', () => {
  const docs = [
    doc('tz1', { doc_type: 'tz', name: 'ТЗ v1.md', uploaded_at: '2026-07-01T00:00:00.000Z' }),
    doc('tz2', { doc_type: 'tz', name: 'ТЗ v2.md', uploaded_at: '2026-07-10T00:00:00.000Z' }),
    doc('v1'),
    doc('v0', { actuality_status: 'superseded' }),
    doc('dangling', { supersedes_document_id: 'deleted-doc' }),
  ];
  const m = buildManifest(docs);
  assert.equal(m.total, 5);
  const tz = m.groups.find((g) => g.doc_type === 'tz');
  const vor = m.groups.find((g) => g.doc_type === 'vor');
  assert.equal(tz.active_count, 2);
  // superseded — в конце группы
  assert.equal(vor.documents[vor.documents.length - 1].id, 'v0');
  const codes = m.warnings.map((w) => w.code);
  assert.ok(codes.includes('supersedes_missing'));
  assert.ok(codes.includes('ambiguous_tz_md'));
});

// --- Вклад манифеста в ревизию набора документов ------------------------------

test('manifestRevisionSuffix: пустой при дефолтной разметке — ревизии нетронутых тендеров не меняются', () => {
  assert.equal(manifestRevisionSuffix(doc('a')), '');
  assert.equal(manifestRevisionSuffix({ id: 'x' }), '');
});

test('manifestRevisionSuffix: смена статуса / приоритета / замены меняет суффикс', () => {
  const base = manifestRevisionSuffix(doc('a'));
  const st = manifestRevisionSuffix(doc('a', { actuality_status: 'informational' }));
  const pr = manifestRevisionSuffix(doc('a', { conflict_priority: 3 }));
  const sup = manifestRevisionSuffix(doc('a', { supersedes_document_id: 'b' }));
  assert.notEqual(st, base);
  assert.notEqual(pr, base);
  assert.notEqual(sup, base);
  assert.notEqual(st, pr);
});
