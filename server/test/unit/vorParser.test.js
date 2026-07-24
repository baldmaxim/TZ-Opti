'use strict';

// Структурный разбор ВОР (services/vor): шапка таблицы, объединённые ячейки,
// разные названия колонок, пустые строки, нормализация количеств и единиц,
// координаты ячеек. Без БД, без сети.
// Запуск: npm run test:unit.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');

const {
  normalizeNumber,
  normalizeUnit,
  nameKey,
} = require('../../services/vor/vorNormalize');
const {
  encodeCell,
  expandMerges,
  mapColumns,
  detectHeader,
  parseSheet,
  parseGrids,
} = require('../../services/vor/vorParser');
const { readGridsFromBuffer } = require('../../services/vor/vorReader');

// ── Хелперы ──────────────────────────────────────────────────────────────────
const merge = (r0, c0, r1, c1) => ({ s: { r: r0, c: c0 }, e: { r: r1, c: c1 } });
const sheetOf = (rows, merges = [], name = 'ВОР') => ({ name, index: 0, rows, merges });
const parse = (rows, merges, name) => parseSheet(sheetOf(rows, merges, name));
const byName = (items, part) => items.find((i) => i.name.includes(part));

// ── Числа ────────────────────────────────────────────────────────────────────

test('количества: разделители разрядов, запятая/точка, число Excel, мусор → null', () => {
  assert.equal(normalizeNumber('1 234,56'), 1234.56);         // обычный пробел
  assert.equal(normalizeNumber('1 234,56'), 1234.56);         // неразрывный пробел
  assert.equal(normalizeNumber('1 234,56'), 1234.56);        // узкий пробел
  assert.equal(normalizeNumber('1,234.56'), 1234.56);         // английский формат
  assert.equal(normalizeNumber('1.234,56'), 1234.56);         // немецкий формат
  assert.equal(normalizeNumber('1,5'), 1.5);
  assert.equal(normalizeNumber('1,234,567'), 1234567);
  assert.equal(normalizeNumber(42), 42);
  assert.equal(normalizeNumber(0), 0);
  assert.equal(normalizeNumber('≈ 15'), 15);
  assert.equal(normalizeNumber('120 м3'), 120, 'единица в той же ячейке не мешает прочитать число');
  assert.equal(normalizeNumber('-3,5'), -3.5);
  assert.equal(normalizeNumber('−3,5'), -3.5, 'типографский минус');

  assert.equal(normalizeNumber(''), null);
  assert.equal(normalizeNumber(null), null);
  assert.equal(normalizeNumber('—'), null);
  assert.equal(normalizeNumber('по проекту'), null);
  assert.equal(normalizeNumber('10-12'), null, 'диапазон — не число, величина неоднозначна');
});

// ── Единицы ──────────────────────────────────────────────────────────────────

test('единицы измерения: разные написания сводятся к одной канонической', () => {
  const u = (s) => normalizeUnit(s).unit;
  assert.equal(u('м2'), 'м2');
  assert.equal(u('М2'), 'м2');
  assert.equal(u('м²'), 'м2');
  assert.equal(u('кв.м'), 'м2');
  assert.equal(u('кв. м.'), 'м2');
  assert.equal(u('м3'), 'м3');
  assert.equal(u('куб.м'), 'м3');
  assert.equal(u('м³'), 'м3');
  assert.equal(u('м.п.'), 'м');
  assert.equal(u('пог.м'), 'м');
  assert.equal(u('мп'), 'м');
  assert.equal(u('шт.'), 'шт');
  assert.equal(u('ШТ'), 'шт');
  assert.equal(u('т'), 'т');
  assert.equal(u('тн'), 'т');
  assert.equal(u('компл.'), 'компл');
  assert.equal(u('к-т'), 'компл');
  assert.equal(u('чел.-ч'), 'чел-ч');
  assert.equal(u('маш.-ч'), 'маш-ч');
  assert.equal(u('%'), '%');
  assert.equal(u('м2 покрытия'), 'м2', 'хвост после единицы не мешает');

  assert.equal(normalizeUnit('кв.м').known, true);
  const weird = normalizeUnit('усл.объект');
  assert.equal(weird.known, false, 'незнакомая единица помечается как нераспознанная');
  assert.equal(weird.raw, 'усл.объект', 'исходное написание сохраняется');
  assert.equal(normalizeUnit('').unit, '');
});

test('nameKey: одна работа с разной пунктуацией/регистром даёт один ключ', () => {
  assert.equal(
    nameKey('Кладка стен из газоблока, толщ. 200 мм'),
    nameKey('кладка  стен из газоблока толщ 200 мм'),
  );
  assert.notEqual(nameKey('Кладка стен 200 мм'), nameKey('Кладка стен 100 мм'));
});

// ── Координаты и объединённые ячейки ─────────────────────────────────────────

test('encodeCell: адреса как в Excel, включая колонки за Z', () => {
  assert.equal(encodeCell(0, 0), 'A1');
  assert.equal(encodeCell(11, 2), 'C12');
  assert.equal(encodeCell(0, 25), 'Z1');
  assert.equal(encodeCell(0, 26), 'AA1');
  assert.equal(encodeCell(4, 27), 'AB5');
});

test('expandMerges: значение объединённого блока раздаётся всем его ячейкам с пометкой источника', () => {
  const rows = [
    ['Наименование', 'Кол-во'],
    ['Кладка стен', 10],
    ['', 20],
    ['', 30],
  ];
  const { grid, mergeOrigin } = expandMerges(rows, [merge(1, 0, 3, 0)]);
  assert.equal(grid[2][0], 'Кладка стен');
  assert.equal(grid[3][0], 'Кладка стен');
  assert.deepEqual(mergeOrigin.get('2:0'), { row: 1, col: 0 });
  assert.equal(mergeOrigin.has('1:0'), false, 'сама ячейка-источник не помечается');
  assert.equal(rows[2][0], '', 'исходная сетка не мутируется');
});

test('объединённая ячейка наименования: каждая строка блока становится своей позицией', () => {
  const rows = [
    ['№', 'Наименование работ', 'Ед. изм.', 'Кол-во'],
    [1, 'Монтаж перегородок ГКЛ', 'м2', 100],
    [2, '', 'м2', 250],
    [3, '', 'м2', 75],
    [4, 'Окраска стен', 'м2', 400],
  ];
  const { items, stats } = parse(rows, [merge(1, 1, 3, 1)]);

  assert.equal(items.length, 4, 'позиции объединённого блока не должны потеряться');
  assert.equal(stats.items, 4);
  const gkl = items.filter((i) => i.name === 'Монтаж перегородок ГКЛ');
  assert.equal(gkl.length, 3);
  assert.deepEqual(gkl.map((i) => i.quantity), [100, 250, 75], 'у каждой строки своё количество');
  assert.deepEqual(gkl.map((i) => i.row_index), [2, 3, 4]);
  // Координаты: своя ячейка количества, но общий источник наименования.
  assert.equal(gkl[1].cells.quantity, 'D3');
  assert.equal(gkl[1].cells.name, 'B3');
  assert.equal(gkl[1].merged_cells.name, 'B2', 'видно, что наименование пришло из объединённой ячейки');
  assert.equal(gkl[0].merged_cells.name, undefined);
});

test('двухэтажная шапка с объединёнными ячейками: колонки собираются из обеих строк', () => {
  const rows = [
    ['Ведомость объёмов работ по объекту «Жилой дом»', '', '', '', ''],
    ['№', 'Наименование', 'Ед.', 'Кол-во', ''],
    ['п/п', 'работ и затрат', 'изм.', 'по ПД', 'по факту'],
    [1, 'Устройство фундаментной плиты', 'м3', 1250, 1300],
  ];
  // «Кол-во» объединено на две колонки (по ПД / по факту), «№» — на две строки.
  const { items, header } = parse(rows, [merge(1, 3, 1, 4), merge(1, 0, 2, 0)]);

  assert.equal(header.row_index, 2, 'шапка найдена на второй строке');
  assert.equal(header.span, 2, 'шапка двухэтажная');
  assert.equal(header.columns.name.label, 'Наименование работ и затрат');
  assert.equal(header.columns.unit.label, 'Ед. изм.');
  assert.equal(header.columns.quantity.label, 'Кол-во по ПД');
  assert.equal(items.length, 1);
  assert.equal(items[0].quantity, 1250, 'берётся первая колонка количества');
  assert.equal(items[0].unit, 'м3');
  assert.equal(items[0].row_index, 4);
});

// ── Разные названия колонок ──────────────────────────────────────────────────

test('mapColumns: синонимы колонок разных форм ведомости', () => {
  const variants = [
    ['№ п/п', 'Наименование работ', 'Ед. изм.', 'Кол-во', 'Примечание'],
    ['Поз.', 'Наименование работ и затрат', 'Единица измерения', 'Количество', 'Прим.'],
    ['№', 'Вид работ', 'Ед.', 'Объём', 'Комментарий'],
    ['Номер позиции', 'Описание работ', 'Ед.изм', 'Кол-во', 'Пояснение'],
  ];
  for (const labels of variants) {
    const cols = mapColumns(labels);
    assert.equal(cols.position, 0, `позиция: ${labels[0]}`);
    assert.equal(cols.name, 1, `наименование: ${labels[1]}`);
    assert.equal(cols.unit, 2, `единица: ${labels[2]}`);
    assert.equal(cols.quantity, 3, `количество: ${labels[3]}`);
    assert.equal(cols.note, 4, `примечание: ${labels[4]}`);
  }
});

test('шифр расценки и раздел читаются отдельными колонками, цена — не количество', () => {
  const rows = [
    ['Поз.', 'Шифр расценки', 'Раздел', 'Наименование работ и затрат', 'Единица измерения', 'Количество', 'Цена, руб', 'Прим.'],
    ['1', 'ГЭСН 08-02-001', 'Каменные работы', 'Кладка наружных стен', 'м3', '1 250,5', '12 500,00', 'газоблок D500'],
  ];
  const { items, header } = parse(rows);
  assert.equal(items.length, 1);
  const it = items[0];
  assert.equal(it.position_no, '1');
  assert.equal(it.code, 'ГЭСН 08-02-001');
  assert.equal(it.section, 'Каменные работы');
  assert.equal(it.name, 'Кладка наружных стен');
  assert.equal(it.unit, 'м3');
  assert.equal(it.quantity, 1250.5);
  assert.equal(it.quantity_raw, '1 250,5', 'исходная запись количества сохранена');
  assert.equal(it.note, 'газоблок D500');
  assert.equal(header.columns.price.index, 6, 'колонка цены распознана отдельно');
  assert.equal(it.cells.name, 'D2');
  assert.equal(it.cells.quantity, 'F2');
});

test('шапка не найдена (нет колонки наименования) — лист пропускается с предупреждением', () => {
  const { items, header, warnings } = parse([
    ['Объект', 'Договор'],
    ['Жилой дом', '№ 12/24'],
  ]);
  assert.equal(items.length, 0);
  assert.equal(header, null);
  assert.equal(warnings[0].code, 'header_not_found');
});

test('detectHeader: строка с номерами колонок не принимается за шапку', () => {
  const rows = [
    ['№ п/п', 'Наименование работ', 'Ед. изм.', 'Кол-во'],
    ['1', '2', '3', '4'],
    ['1', 'Демонтаж перегородок', 'м2', '55'],
  ];
  const { items, header } = parse(rows);
  assert.equal(header.row_index, 1);
  assert.equal(items.length, 1, 'строка «1|2|3|4» — не позиция ведомости');
  assert.equal(items[0].name, 'Демонтаж перегородок');
});

// ── Пустые строки, разделы, итоги ────────────────────────────────────────────

test('пустые строки, разделы и итоги: в позиции попадают только работы', () => {
  const rows = [
    ['№ п/п', 'Наименование работ', 'Ед. изм.', 'Кол-во'],
    [],
    ['', '', '', ''],
    ['', 'Раздел 1. Земляные работы', '', ''],
    ['1', 'Разработка грунта экскаватором', 'м3', '1 250,5'],
    ['   ', '  ', '', ''],
    ['2', 'Обратная засыпка', 'м3', 830],
    ['', 'Итого по разделу 1', '', 2080],
    ['', 'Раздел 2. Бетонные работы', '', ''],
    ['3', 'Устройство бетонной подготовки', 'м2', 340],
    ['', 'Всего по ведомости', '', ''],
    [],
  ];
  const { items, stats } = parse(rows);

  assert.equal(items.length, 3, 'пустые строки, разделы и итоги не позиции');
  assert.deepEqual(items.map((i) => i.name), [
    'Разработка грунта экскаватором',
    'Обратная засыпка',
    'Устройство бетонной подготовки',
  ]);
  assert.equal(items[0].section, 'Раздел 1. Земляные работы');
  assert.equal(items[1].section, 'Раздел 1. Земляные работы', 'раздел тянется до следующего заголовка');
  assert.equal(items[2].section, 'Раздел 2. Бетонные работы');
  assert.equal(items[0].row_index, 5, 'номер строки Excel сохранён, несмотря на пустые строки');
  assert.equal(stats.sections, 2);
  assert.equal(stats.totals, 2);
  assert.ok(stats.skipped >= 4);
});

test('перенос длинного наименования на следующую строку приклеивается к позиции', () => {
  const rows = [
    ['№', 'Наименование работ', 'Ед. изм.', 'Кол-во'],
    ['1', 'Монтаж витражных конструкций из алюминиевого профиля', 'м2', 320],
    ['', 'с заполнением стеклопакетом 6-16-6', '', ''],
    ['2', 'Окраска фасада', 'м2', 500],
  ];
  const { items } = parse(rows);
  assert.equal(items.length, 2);
  assert.equal(
    items[0].name,
    'Монтаж витражных конструкций из алюминиевого профиля с заполнением стеклопакетом 6-16-6',
  );
});

test('нечисловое количество и незнакомая единица сохраняются как есть + предупреждение', () => {
  const rows = [
    ['№', 'Наименование работ', 'Ед. изм.', 'Кол-во'],
    ['1', 'Пусконаладочные работы', 'усл.объект', 'по проекту'],
    ['2', 'Уборка помещений', 'м2', 1000],
  ];
  const { items, warnings } = parse(rows);
  const it = items[0];
  assert.equal(it.quantity, null);
  assert.equal(it.quantity_raw, 'по проекту');
  assert.equal(it.unit_known, false);
  assert.equal(it.unit, 'усл.объект');
  assert.ok(warnings.some((w) => w.code === 'quantity_unparsed'));
  assert.ok(warnings.some((w) => w.code === 'unit_unknown'));
});

test('нет колонки количества — позиции всё равно импортируются, но с предупреждением', () => {
  const rows = [
    ['№', 'Наименование работ', 'Ед. изм.'],
    ['1', 'Устройство кровли', 'м2'],
  ];
  const { items, warnings } = parse(rows);
  assert.equal(items.length, 1);
  assert.equal(items[0].quantity, null);
  assert.ok(warnings.some((w) => w.code === 'no_quantity_column'));
});

// ── Книга целиком ────────────────────────────────────────────────────────────

test('parseGrids: несколько листов, сквозной порядок, сводная статистика', () => {
  const head = ['№', 'Наименование работ', 'Ед. изм.', 'Кол-во'];
  const grids = [
    sheetOf([head, ['1', 'Демонтаж перегородок', 'м2', 55]], [], 'Демонтаж'),
    { name: 'Отделка', index: 1, rows: [head, ['1', 'Штукатурка стен', 'м2', 900], ['2', 'Окраска стен', 'м2', 900]], merges: [] },
    { name: 'Титул', index: 2, rows: [['Объект', 'Жилой дом']], merges: [] },
  ];
  const { items, sheets, stats } = parseGrids(grids);

  assert.equal(items.length, 3);
  assert.deepEqual(items.map((i) => i.order_idx), [0, 1, 2], 'сквозная нумерация по всей книге');
  assert.deepEqual(items.map((i) => i.sheet_name), ['Демонтаж', 'Отделка', 'Отделка']);
  assert.equal(items[1].sheet_index, 1);
  assert.equal(stats.sheets, 3);
  assert.equal(stats.sheets_parsed, 2, 'титульный лист без таблицы не считается разобранным');
  assert.equal(stats.with_quantity, 3);
  assert.equal(stats.with_unit, 3);
  assert.equal(sheets[2].header, null);
});

// ── Реальный xlsx (запись → чтение → разбор) ─────────────────────────────────

test('xls/xlsx: файл с объединёнными ячейками читается и разбирается end-to-end', () => {
  const rows = [
    ['Ведомость объёмов работ'],
    ['№ п/п', 'Наименование работ', 'Ед. изм.', 'Кол-во', 'Примечание'],
    ['', 'Раздел 1. Монолитные работы', '', '', ''],
    [1, 'Бетонирование стен', 'м3', 1250.5, 'B25'],
    [2, '', 'м3', 320, 'B30'],
    ['', '', '', '', ''],
    [3, 'Армирование', 'т', '12,75', ''],
    ['', 'Итого', '', 1583.25, ''],
  ];
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet['!merges'] = [merge(3, 1, 4, 1)]; // наименование на две строки
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, 'ВОР');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const grids = readGridsFromBuffer(buffer);
  assert.equal(grids.length, 1);
  assert.equal(grids[0].merges.length, 1);

  const { items, stats } = parseGrids(grids);
  assert.equal(items.length, 3);
  assert.equal(stats.items, 3);

  const beton = items.filter((i) => i.name === 'Бетонирование стен');
  assert.equal(beton.length, 2, 'объединённое наименование раздалось обеим строкам');
  assert.deepEqual(beton.map((i) => i.quantity), [1250.5, 320]);
  assert.equal(beton[1].merged_cells.name, 'B4');
  assert.equal(beton[0].section, 'Раздел 1. Монолитные работы');
  assert.equal(beton[0].sheet_name, 'ВОР');
  assert.equal(beton[0].row_index, 4);
  assert.equal(beton[0].cells.quantity, 'D4');

  const arm = byName(items, 'Армирование');
  assert.equal(arm.quantity, 12.75, 'запятая как десятичный разделитель в тексте ячейки');
  assert.equal(arm.unit, 'т');
  assert.equal(items.some((i) => /итого/i.test(i.name)), false, 'итоговая строка не позиция');
});
