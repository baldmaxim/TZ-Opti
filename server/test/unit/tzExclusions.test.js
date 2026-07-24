'use strict';

// Юнит-тесты применения исключений ТЗ (tzActiveTextService.js) — без БД и LLM.
// Проверяют чистое ядро: нормализацию/слияние интервалов (вложенные, пересечения,
// соседние), применение к блокам и привязку исключений к ревизии документа
// (новая версия ТЗ → исключения прошлой ревизии не применяются). Запуск: npm test.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeAndMerge,
  applyExclusions,
  hashText,
  computeRevisionId,
  nodeIdFor,
  isStaleAgainst,
  selectApplicableExclusions,
} = require('../../services/tzActiveTextService');

// Блок из 10 символов: A0 B1 C2 D3 E4 F5 G6 H7 I8 J9.
const TEXT = 'ABCDEFGHIJ';
const block = (over = {}) => ({ index: 0, text: TEXT, ...over });
const rng = (char_start, char_end, over = {}) => ({ paragraph_index: 0, char_start, char_end, ...over });
const applyText = (ranges) => applyExclusions([block()], ranges)[0].text;

// --- normalizeAndMerge: вложенные / пересечения / соседние ---------------------

test('normalizeAndMerge: вложенный интервал не укорачивает внешний', () => {
  // [0,10) содержит [2,5) → один интервал [0,10), а не «обрезанный» до 5.
  assert.deepEqual(normalizeAndMerge([{ char_start: 0, char_end: 10 }, { char_start: 2, char_end: 5 }], 10), [[0, 10]]);
});

test('normalizeAndMerge: пересекающиеся сливаются', () => {
  assert.deepEqual(normalizeAndMerge([{ char_start: 0, char_end: 4 }, { char_start: 2, char_end: 6 }], 10), [[0, 6]]);
});

test('normalizeAndMerge: соседние ([a,b)+[b,c)) сливаются в один', () => {
  assert.deepEqual(normalizeAndMerge([{ char_start: 0, char_end: 3 }, { char_start: 3, char_end: 6 }], 10), [[0, 6]]);
});

test('normalizeAndMerge: непересекающиеся с зазором остаются раздельными', () => {
  assert.deepEqual(normalizeAndMerge([{ char_start: 0, char_end: 2 }, { char_start: 5, char_end: 7 }], 10), [[0, 2], [5, 7]]);
});

test('normalizeAndMerge: неупорядоченный вход + клампинг за границы блока', () => {
  const out = normalizeAndMerge(
    [{ char_start: 5, char_end: 7 }, { char_start: 0, char_end: 2 }, { char_start: 8, char_end: 999 }],
    10,
  );
  assert.deepEqual(out, [[0, 2], [5, 7], [8, 10]]);
});

test('normalizeAndMerge: пустые/инвертированные интервалы отбрасываются', () => {
  assert.deepEqual(normalizeAndMerge([{ char_start: 5, char_end: 5 }, { char_start: 6, char_end: 3 }], 10), []);
});

// --- applyExclusions: тот же набор кейсов, но по тексту ------------------------

test('applyExclusions: ВЛОЖЕННЫЕ диапазоны — курсор не откатывается назад', () => {
  // Регресс: раньше [0,10)+[2,5) возвращали «FGHIJ» (курсор откатывался с 10 на 5).
  assert.equal(applyText([rng(0, 10), rng(2, 5)]), '');
  // Частично вложенный: [1,9) содержит [3,5) → остаётся только 'A' и 'J'.
  assert.equal(applyText([rng(1, 9), rng(3, 5)]), 'AJ');
});

test('applyExclusions: пересекающиеся диапазоны', () => {
  assert.equal(applyText([rng(0, 4), rng(2, 6)]), 'GHIJ'); // вырезано [0,6)
});

test('applyExclusions: соседние диапазоны вырезаются как один', () => {
  assert.equal(applyText([rng(0, 3), rng(3, 6)]), 'GHIJ');
});

test('applyExclusions: непересекающиеся диапазоны вырезаются раздельно', () => {
  assert.equal(applyText([rng(0, 2), rng(5, 7)]), 'CDEHIJ');
});

test('applyExclusions: неупорядоченный вход + выход за границы', () => {
  assert.equal(applyText([rng(5, 7), rng(0, 2), rng(8, 999)]), 'CDEH');
});

test('applyExclusions: затрагивает только блок с совпадающим paragraph_index', () => {
  const blocks = [
    { index: 0, text: 'ABCDEFGHIJ' },
    { index: 1, text: 'KLMNOP' },
  ];
  const out = applyExclusions(blocks, [{ paragraph_index: 0, char_start: 0, char_end: 4 }]);
  assert.equal(out[0].text, 'EFGHIJ');
  assert.equal(out[1].text, 'KLMNOP'); // другой абзац не тронут
  assert.equal(out[0].hadExclusion, true);
  assert.equal(out[1].hadExclusion, undefined);
});

test('applyExclusions: пустой список диапазонов возвращает блоки как есть', () => {
  const blocks = [block()];
  assert.equal(applyExclusions(blocks, []), blocks);
});

// --- Идентификаторы ревизии / узла / хэша -------------------------------------

test('computeRevisionId: детерминирован и меняется при смене содержимого/документа', () => {
  const v1 = { id: 'doc-1', version: '1', extracted_text: 'Пункт 1. Объём.' };
  assert.equal(computeRevisionId(v1), computeRevisionId({ ...v1 }), 'та же ревизия — тот же id');
  assert.notEqual(computeRevisionId(v1), computeRevisionId({ ...v1, extracted_text: 'Пункт 1. Объём. Изменено.' }));
  assert.notEqual(computeRevisionId(v1), computeRevisionId({ ...v1, id: 'doc-2' }));
  assert.match(computeRevisionId(v1), /^rev_[0-9a-f]{24}$/);
});

test('nodeIdFor: стабилен при сдвиге индекса, меняется при смене текста', () => {
  const b1 = { index: 3, type: 'paragraph', section_path: ['1. Объём'], text: 'Демонтаж конструкций.' };
  const moved = { ...b1, index: 7 }; // тот же узел на другой позиции
  assert.equal(nodeIdFor(b1), nodeIdFor(moved), 'node_id не зависит от paragraph_index');
  assert.notEqual(nodeIdFor(b1), nodeIdFor({ ...b1, text: 'Другой текст.' }));
  assert.notEqual(nodeIdFor(b1), nodeIdFor({ ...b1, section_path: ['2. Иное'] }));
});

test('hashText: нормализует пробелы, детерминирован', () => {
  assert.equal(hashText('  a   b '), hashText('a b'));
  assert.match(hashText('x'), /^h_[0-9a-f]{24}$/);
});

// --- Привязка к ревизии: новая версия документа --------------------------------

test('isStaleAgainst: исключение другой ревизии устаревает, своей — нет', () => {
  const ex = { document_revision_id: 'rev_A', source_document_id: 'doc-1', stale: 0 };
  assert.equal(isStaleAgainst(ex, 'rev_B', 'doc-2'), true, 'другая ревизия → stale');
  assert.equal(isStaleAgainst(ex, 'rev_A', 'doc-1'), false, 'своя ревизия → не stale');
  assert.equal(isStaleAgainst({ ...ex, stale: 1 }, 'rev_B', 'doc-2'), false, 'уже помечено');
});

test('isStaleAgainst: легаси-запись (revision=NULL) устаревает при другом документе', () => {
  const legacy = { document_revision_id: null, source_document_id: 'doc-1', stale: 0 };
  assert.equal(isStaleAgainst(legacy, 'rev_B', 'doc-2'), true);
  assert.equal(isStaleAgainst(legacy, 'rev_B', 'doc-1'), false, 'тот же документ → применимо');
});

test('НОВАЯ РЕВИЗИЯ: исключения прошлой версии ТЗ НЕ применяются к новой', () => {
  const v1 = { id: 'doc-1', version: '1', extracted_text: 'Пункт 1. Объём работ.' };
  const v2 = { id: 'doc-2', version: '1', extracted_text: 'Пункт 1. Объём работ. Пункт 2. Новое.' };
  const revV1 = computeRevisionId(v1);
  const revV2 = computeRevisionId(v2);
  assert.notEqual(revV1, revV2);

  // Исключение посчитано на ревизии v1.
  const exV1 = {
    id: 'ex1', document_revision_id: revV1, source_document_id: 'doc-1',
    node_id: 'nd_x', source_text_hash: 'h_x',
    paragraph_index: 0, char_start: 0, char_end: 5, after_stage: 1, stale: 0,
  };

  // Текущая версия — v2: исключение прошлой ревизии НЕ применяется…
  assert.deepEqual(
    selectApplicableExclusions([exV1], { revisionId: revV2, documentId: 'doc-2', beforeStage: 99 }),
    [],
    'исключение ревизии v1 не применяется к v2',
  );
  // …и признаётся устаревшим (кандидат на пометку stale + подтверждение).
  assert.equal(isStaleAgainst(exV1, revV2, 'doc-2'), true);

  // На своей ревизии v1 оно по-прежнему применяется.
  assert.deepEqual(
    selectApplicableExclusions([exV1], { revisionId: revV1, documentId: 'doc-1', beforeStage: 99 }),
    [exV1],
  );
});

test('selectApplicableExclusions: фильтрует stale, чужую ревизию и after_stage', () => {
  const rev = 'rev_cur';
  const doc = 'doc-cur';
  const ranges = [
    { id: 'ok', document_revision_id: rev, source_document_id: doc, after_stage: 1, stale: 0 },
    { id: 'legacy-ok', document_revision_id: null, source_document_id: doc, after_stage: 1, stale: 0 },
    { id: 'other-rev', document_revision_id: 'rev_old', source_document_id: 'doc-old', after_stage: 1, stale: 0 },
    { id: 'legacy-other-doc', document_revision_id: null, source_document_id: 'doc-old', after_stage: 1, stale: 0 },
    { id: 'stale', document_revision_id: rev, source_document_id: doc, after_stage: 1, stale: 1 },
    { id: 'later-stage', document_revision_id: rev, source_document_id: doc, after_stage: 5, stale: 0 },
  ];
  const out = selectApplicableExclusions(ranges, { revisionId: rev, documentId: doc, beforeStage: 3 });
  assert.deepEqual(out.map((r) => r.id).sort(), ['legacy-ok', 'ok']);
});
