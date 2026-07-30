'use strict';

// Юнит-тесты чистого ядра tzActiveTextService.js — без БД и LLM.
// Идентификаторы ревизии/узла/текста и слияние интервалов (используется билдером
// согласованной версии ТЗ). Применение исключений (tz_excluded_ranges)
// демонтировано: вход анализа неизменяем. Запуск: npm run test:unit.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeAndMerge,
  hashText,
  computeRevisionId,
  nodeIdFor,
} = require('../../services/tzActiveTextService');

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
