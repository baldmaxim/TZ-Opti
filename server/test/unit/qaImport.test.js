'use strict';

// Юнит-тесты чистого ядра импорта Q&A (qaImportService) — без БД и файлов.
// parseSheetRows: разбор матрицы строк листа (шапка, раунды, служебные строки).
// diffQaEntries: сопоставление входящих записей с активными — new /
// answer_changed (с явной связью на отменяемый ответ) / unchanged.
// Запуск: npm run test:unit.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseSheetRows, diffQaEntries } = require('../../services/qaImportService');

const HEADER = ['№', 'Дата', 'Дата получения ответа', 'Раздел', 'Вопрос', 'Ответ', 'Принятые решения'];

function sheetRows(entries) {
  return [
    ['Форма ВОПРОС-ОТВЕТ'],
    HEADER,
    ['1', '2', '3', '4', '5', '6', '7'], // строка с номерами колонок — служебная
    ...entries,
  ];
}

// --- parseSheetRows -----------------------------------------------------------

test('parseSheetRows: шапка ищется автоматически, служебная строка пропускается', () => {
  const out = parseSheetRows('Лист1', sheetRows([
    ['1', '01.02.2026', '05.02.2026', 'Кровля', 'Чей материал?', 'Материал подрядчика', 'Учесть в КП'],
  ]));
  assert.equal(out.ok, true);
  assert.equal(out.entries.length, 1);
  assert.deepEqual(
    { q: out.entries[0].question, a: out.entries[0].answer, s: out.entries[0].section },
    { q: 'Чей материал?', a: 'Материал подрядчика', s: 'Кровля' },
  );
  assert.equal(out.entries[0].accepted_decision, 'Учесть в КП');
});

test('parseSheetRows: строка «направлено…» становится round_label для последующих', () => {
  const out = parseSheetRows('Лист1', sheetRows([
    ['', '', '', '', 'Направлено 01.02.2026', '', ''],
    ['1', '', '', '', 'Вопрос 1', 'Ответ 1', ''],
    ['', '', '', '', 'направлено 15.02.2026 повторно', '', ''],
    ['2', '', '', '', 'Вопрос 2', 'Ответ 2', ''],
  ]));
  assert.equal(out.entries.length, 2);
  assert.equal(out.entries[0].round_label, 'Направлено 01.02.2026');
  assert.equal(out.entries[1].round_label, 'направлено 15.02.2026 повторно');
  assert.equal(out.rounds.length, 2);
});

test('parseSheetRows: лист без шапки — непригоден, но не бросает', () => {
  const out = parseSheetRows('Оглавление', [['Содержание'], ['1. Раздел', 'стр. 3']]);
  assert.equal(out.ok, false);
  assert.match(out.reason, /шапка/);
  assert.deepEqual(out.entries, []);
});

test('parseSheetRows: пустой лист и лист без единой пары — непригодны', () => {
  assert.equal(parseSheetRows('Пустой', []).ok, false);
  assert.equal(parseSheetRows('БезПар', sheetRows([])).ok, false);
});

// --- diffQaEntries ------------------------------------------------------------

const active = (over = {}) => ({
  id: over.id || 'e1', question: 'Чей материал?', answer: 'Материал подрядчика', ...over,
});
const inc = (over = {}) => ({
  question: 'Чей материал?', answer: 'Материал подрядчика', section: null, ...over,
});

test('diffQaEntries: тот же вопрос и ответ → unchanged (дубль не вставляется)', () => {
  const { items, summary } = diffQaEntries([active()], [inc()]);
  assert.equal(summary.unchanged, 1);
  assert.equal(items[0].kind, 'unchanged');
  assert.equal(items[0].current_id, 'e1');
});

test('diffQaEntries: тот же вопрос, ДРУГОЙ ответ → answer_changed со связью на отменяемый', () => {
  const { items, summary } = diffQaEntries(
    [active()],
    [inc({ answer: 'Материал заказчика (уточнение)' })],
  );
  assert.equal(summary.answer_changed, 1);
  assert.equal(items[0].kind, 'answer_changed');
  assert.equal(items[0].current_id, 'e1', 'явная связь нового ответа с отменяемым');
  assert.equal(items[0].current_answer, 'Материал подрядчика');
});

test('diffQaEntries: нового вопроса среди активных нет → new', () => {
  const { items, summary } = diffQaEntries([active()], [inc({ question: 'Кто вывозит мусор?' })]);
  assert.equal(summary.new, 1);
  assert.equal(items[0].current_id, null);
});

test('diffQaEntries: сопоставление вопроса нечувствительно к регистру и пробелам', () => {
  const { summary } = diffQaEntries(
    [active()],
    [inc({ question: '  чей   МАТЕРИАЛ? ' })],
  );
  assert.equal(summary.unchanged, 1);
});

test('diffQaEntries: два одинаковых вопроса в файле не съедают одну активную запись дважды', () => {
  const { items } = diffQaEntries(
    [active()],
    [inc({ answer: 'Новый ответ А' }), inc({ answer: 'Новый ответ Б' })],
  );
  assert.equal(items[0].kind, 'answer_changed');
  assert.equal(items[1].kind, 'new', 'вторая строка не может отменить ту же запись повторно');
});

test('diffQaEntries: строка без вопроса всегда new', () => {
  const { summary } = diffQaEntries([active()], [inc({ question: null, answer: 'Инфо-строка' })]);
  assert.equal(summary.new, 1);
});
