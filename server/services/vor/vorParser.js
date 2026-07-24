'use strict';

// Структурный разбор ВОР (ведомость объёмов работ) из XLS/XLSX.
//
// Раньше ВОР читался как «CSV всего листа», а стадия 1 брала из строки САМУЮ
// ДЛИННУЮ ячейку и считала её наименованием: терялись номер позиции, шифр,
// единица, количество и координаты, а сам текст раздувался до сотен тысяч
// символов и целиком выбрасывался из анализа по лимиту.
//
// Здесь: находим строку заголовков (в т.ч. двухэтажную), раскрываем
// объединённые ячейки, размечаем колонки по названиям (десятки вариантов
// написания), классифицируем строки (позиция / раздел / итог / пустая) и
// отдаём ПОЗИЦИИ со всеми координатами.
//
// Модуль ЧИСТЫЙ: на вход — «сетка» (значения ячеек + список объединений),
// на выход — позиции. Ни xlsx, ни БД, ни сети → офлайн-тесты.

const {
  normalizeNumber,
  normalizeUnit,
  normalizeText,
  nameKey,
} = require('./vorNormalize');

// ── Координаты ячеек (A1) ────────────────────────────────────────────────────
function encodeCol(col) {
  let c = Number(col);
  let s = '';
  do {
    s = String.fromCharCode(65 + (c % 26)) + s;
    c = Math.floor(c / 26) - 1;
  } while (c >= 0);
  return s;
}

// row/col — 0-based (как в xlsx), результат — привычный инженеру адрес «C12».
const encodeCell = (row, col) => `${encodeCol(col)}${Number(row) + 1}`;

// ── Объединённые ячейки ──────────────────────────────────────────────────────
// В xlsx значение объединённого блока лежит ТОЛЬКО в левой верхней ячейке,
// остальные пусты. Для разбора строк это смертельно: наименование, объединённое
// на 5 строк (5 разных объёмов), досталось бы лишь первой позиции.
// Раскрываем блок значением-источником и помним, откуда оно пришло.
function expandMerges(rows, merges = []) {
  const grid = rows.map((r) => (Array.isArray(r) ? [...r] : []));
  const origin = new Map(); // 'r:c' → { row, col } (только для заполненных нами)
  for (const m of merges || []) {
    if (!m || !m.s || !m.e) continue;
    const { r: r0, c: c0 } = m.s;
    const { r: r1, c: c1 } = m.e;
    const src = grid[r0] ? grid[r0][c0] : undefined;
    if (src === undefined || src === null || src === '') continue;
    for (let r = r0; r <= r1; r += 1) {
      if (!grid[r]) grid[r] = [];
      for (let c = c0; c <= c1; c += 1) {
        if (r === r0 && c === c0) continue;
        const cur = grid[r][c];
        if (cur === undefined || cur === null || cur === '') {
          grid[r][c] = src;
          origin.set(`${r}:${c}`, { row: r0, col: c0 });
        }
      }
    }
  }
  return { grid, mergeOrigin: origin };
}

// ── Разметка колонок ─────────────────────────────────────────────────────────
// Порядок ВАЖЕН: проверяем от более специфичных шаблонов к общим.
// Цена/сумма распознаются отдельно — только чтобы не утечь в «количество».
const COLUMN_PATTERNS = [
  ['note', /примечан|коммент|пояснен|сноск|^\s*прим\.?\s*$/i],
  ['price', /цена|стоимост|сумма|тариф|расцен(ка|ки)\s*в\s*руб|руб\.?$|тенге|₸/i],
  ['code', /шифр|^\s*код|расценк|обоснован|норматив|артикул/i],
  ['unit', /ед\.?\s*изм|единиц[аы]?\s*измер|^\s*ед\.?\s*$|^\s*e\.?\s*и\.?\s*$/i],
  ['quantity', /кол[-\s.]*во|количеств|^\s*объ[её]м|^\s*кол\.?\s*$|^\s*q(ty)?\s*$/i],
  ['section', /раздел|^\s*глава|^\s*блок\s*$|^\s*этап\s*$|^\s*группа\s*$|подсистем/i],
  ['name', /наименован|^\s*работ|вид\s*работ|описан|перечень\s*работ|содержание\s*работ|^\s*name/i],
  ['position', /^\s*№|^\s*n\s*$|п\/п|^\s*поз|номер\s*(п\/п|позиц)/i],
];

// labels — массив строк по колонкам. Возвращает { field → colIndex }.
function mapColumns(labels) {
  const columns = {};
  const taken = new Set();
  // Два прохода: сначала специфичные шаблоны (в порядке COLUMN_PATTERNS),
  // затем — чтобы «Наименование» не перехватило колонку «№ наименования».
  for (const [field, re] of COLUMN_PATTERNS) {
    for (let c = 0; c < labels.length; c += 1) {
      if (taken.has(c)) continue;
      const label = normalizeText(labels[c]);
      if (!label || !re.test(label)) continue;
      if (columns[field] === undefined) {
        columns[field] = c;
        taken.add(c);
      }
      break;
    }
  }
  return columns;
}

// Сколько «полей ведомости» распознала строка. Без наименования это не шапка.
const REQUIRED_FIELD = 'name';
function scoreHeader(columns) {
  if (columns[REQUIRED_FIELD] === undefined) return 0;
  let score = 1;
  for (const f of ['unit', 'quantity', 'position', 'code', 'note', 'section']) {
    if (columns[f] !== undefined) score += 1;
  }
  // Единица + количество — подпись настоящей ведомости объёмов.
  if (columns.unit !== undefined && columns.quantity !== undefined) score += 2;
  return score;
}

function labelsOf(row, width) {
  const out = new Array(width).fill('');
  for (let c = 0; c < width; c += 1) out[c] = normalizeText(row ? row[c] : '');
  return out;
}

function combineLabels(a, b) {
  return a.map((label, c) => {
    const second = b[c] || '';
    if (!label) return second;
    if (!second || label === second) return label;
    return `${label} ${second}`;
  });
}

const DEFAULT_HEADER_SCAN = 40;

// Можно ли считать строку ВТОРЫМ ЭТАЖОМ шапки («п/п» под «№», «изм.» под «Ед.»).
// Второй этаж подписывает НЕСКОЛЬКО колонок РАЗНЫМ коротким текстом и не
// содержит чисел. Этим он отличается и от строки данных (в ней есть числа), и
// от строки-раздела (одна ячейка либо один и тот же текст, размноженный
// объединением на всю ширину).
function canExtendHeader(row, width) {
  const labels = labelsOf(row, width).filter((l) => l !== '');
  if (labels.length < 2) return false;
  if (new Set(labels).size < 2) return false;
  if (labels.some((l) => normalizeNumber(l) !== null)) return false;
  return labels.every((l) => l.length <= 40);
}

// Ищет строку заголовков среди первых maxScan строк. Пробует и одиночную
// строку, и «двухэтажную» шапку («Наименование» над «работ и затрат»),
// и объединённую с третьей строкой — берёт вариант с лучшим счётом.
function detectHeader(rows, opts = {}) {
  const maxScan = Math.min(rows.length, opts.maxScan || DEFAULT_HEADER_SCAN);
  const width = rows.reduce((w, r) => Math.max(w, (r || []).length), 0);
  let best = null;
  for (let i = 0; i < maxScan; i += 1) {
    const one = labelsOf(rows[i], width);
    // Верхняя строка шапки всегда несёт хотя бы одно название колонки. Без
    // этого условия титульная строка листа («Ведомость объёмов работ по
    // объекту …») склеивалась бы с настоящей шапкой ниже и съедала её.
    if (!Object.keys(mapColumns(one)).length) continue;
    // Многоэтажная шапка наращивается, только пока следующая строка похожа на
    // подписи колонок; строка данных или строка-раздел этажом шапки не станут.
    const variants = [{ labels: one, span: 1 }];
    let labels = one;
    for (let span = 2; span <= 3 && i + span - 1 < rows.length; span += 1) {
      if (!canExtendHeader(rows[i + span - 1], width)) break;
      labels = combineLabels(labels, labelsOf(rows[i + span - 1], width));
      variants.push({ labels, span });
    }
    for (const v of variants) {
      const columns = mapColumns(v.labels);
      const raw = scoreHeader(columns);
      if (raw < 2) continue;
      // При РАВНОМ наборе колонок побеждает более высокая шапка: иначе её
      // нижний этаж («п/п», «изм.») уехал бы в данные отдельной «позицией».
      const score = raw + (v.span - 1) * 0.25;
      if (!best || score > best.score) {
        best = { row: i, span: v.span, labels: v.labels, columns, score };
      }
    }
  }
  return best;
}

// ── Классификация строк ──────────────────────────────────────────────────────
const TOTAL_RE = /^\s*(итого|всего|подытог|итог\b|в\s*том\s*числе\s*:?\s*$|сумма\s*по)/i;
const SECTION_RE = /^\s*(раздел|глава|подраздел|этап|блок|часть)\b/i;
// Продолжение наименования на следующей строке: без номера/шифра/объёма и
// начинается со строчной буквы или знака препинания.
const CONTINUATION_RE = /^\s*[а-яёa-z(,;-]/;

function isNumberingRow(values) {
  const filled = values.filter((v) => normalizeText(v) !== '');
  if (filled.length < 3) return false;
  return filled.every((v) => /^\d{1,2}$/.test(normalizeText(v)));
}

// ── Разбор одного листа ──────────────────────────────────────────────────────
function pick(grid, row, col) {
  if (col === undefined || col === null || col < 0) return { raw: '', ref: null };
  const value = grid[row] ? grid[row][col] : undefined;
  return { raw: value === undefined ? '' : value, ref: encodeCell(row, col) };
}

function parseSheet(sheet, opts = {}) {
  const name = sheet.name || '';
  const sheetIndex = Number.isFinite(sheet.index) ? sheet.index : 0;
  const rawRows = Array.isArray(sheet.rows) ? sheet.rows : [];
  const warnings = [];
  const { grid, mergeOrigin } = expandMerges(rawRows, sheet.merges);

  const header = detectHeader(grid, opts);
  if (!header) {
    return {
      sheet: name,
      sheet_index: sheetIndex,
      items: [],
      header: null,
      warnings: [{ code: 'header_not_found', message: `Лист «${name}»: не найдена строка заголовков ведомости.` }],
      stats: { rows: grid.length, items: 0, sections: 0, totals: 0, skipped: grid.length },
    };
  }
  const cols = header.columns;
  if (cols.quantity === undefined) {
    warnings.push({ code: 'no_quantity_column', message: `Лист «${name}»: не найдена колонка количества — объёмы не импортированы.` });
  }
  if (cols.unit === undefined) {
    warnings.push({ code: 'no_unit_column', message: `Лист «${name}»: не найдена колонка единиц измерения.` });
  }

  const items = [];
  let currentSection = '';
  let sections = 0;
  let totals = 0;
  let skipped = 0;
  let badQuantity = 0;
  let unknownUnits = 0;

  for (let r = header.row + header.span; r < grid.length; r += 1) {
    const row = grid[r] || [];
    const values = row.map((v) => normalizeText(v));
    if (!values.some((v) => v !== '')) { skipped += 1; continue; }
    if (isNumberingRow(values)) { skipped += 1; continue; }

    const posCell = pick(grid, r, cols.position);
    const codeCell = pick(grid, r, cols.code);
    const nameCell = pick(grid, r, cols.name);
    const unitCell = pick(grid, r, cols.unit);
    const qtyCell = pick(grid, r, cols.quantity);
    const noteCell = pick(grid, r, cols.note);
    const sectionCell = pick(grid, r, cols.section);

    const position = normalizeText(posCell.raw);
    const code = normalizeText(codeCell.raw);
    const nameText = normalizeText(nameCell.raw);
    const unitText = normalizeText(unitCell.raw);
    const qtyRaw = qtyCell.raw;
    const qtyText = normalizeText(qtyRaw);
    const note = normalizeText(noteCell.raw);
    const sectionText = normalizeText(sectionCell.raw);

    const quantity = normalizeNumber(qtyRaw);
    const unit = normalizeUnit(unitText);
    const nameMerged = mergeOrigin.has(`${r}:${cols.name}`);

    if (!nameText && quantity === null && !unitText) { skipped += 1; continue; }

    // Итоговая строка — не позиция ведомости, но и не раздел.
    if (TOTAL_RE.test(nameText) || (!nameText && TOTAL_RE.test(position))) {
      totals += 1;
      continue;
    }

    // Строка-раздел: есть текст, но нет ни объёма, ни единицы.
    const looksLikeSection = nameText && quantity === null && !unitText;
    if (looksLikeSection) {
      const prev = items[items.length - 1];
      // Перенос длинного наименования на следующую строку (нет номера, нет
      // шифра, начинается со строчной) — приклеиваем к предыдущей позиции.
      if (prev && !nameMerged && !position && !code && CONTINUATION_RE.test(nameText)) {
        prev.name = `${prev.name} ${nameText}`.replace(/\s+/g, ' ').trim();
        prev.name_key = nameKey(prev.name);
        continue;
      }
      // «Раздел 3. Кровля» / «КР. Монолитные конструкции» — заголовок группы:
      // он становится разделом для всех позиций ниже (до следующего заголовка).
      currentSection = SECTION_RE.test(nameText) ? nameText.replace(/^\s*/, '') : nameText;
      sections += 1;
      continue;
    }

    if (!nameText) { skipped += 1; continue; }
    if (qtyText && quantity === null) badQuantity += 1;
    if (unitText && !unit.known) unknownUnits += 1;

    const cells = {};
    const merged = {};
    const put = (field, cell, value) => {
      if (value === '' || value === null || value === undefined) return;
      if (cell.ref) cells[field] = cell.ref;
      const o = mergeOrigin.get(`${r}:${cols[field]}`);
      if (o) merged[field] = encodeCell(o.row, o.col);
    };
    put('position', posCell, position);
    put('code', codeCell, code);
    put('name', nameCell, nameText);
    put('unit', unitCell, unitText);
    put('quantity', qtyCell, qtyText);
    put('note', noteCell, note);
    put('section', sectionCell, sectionText);

    items.push({
      sheet_name: name,
      sheet_index: sheetIndex,
      row_index: r + 1, // 1-based, как показывает Excel
      position_no: position || '',
      code: code || '',
      section: sectionText || currentSection || '',
      name: nameText,
      name_key: nameKey(nameText),
      unit: unit.unit,
      unit_raw: unit.raw,
      unit_known: unit.known,
      quantity,
      quantity_raw: qtyText,
      note: note || '',
      row_kind: 'item',
      cells,
      merged_cells: merged,
    });
  }

  if (badQuantity) {
    warnings.push({
      code: 'quantity_unparsed',
      message: `Лист «${name}»: ${badQuantity} строк с нечисловым количеством — значение сохранено как текст.`,
    });
  }
  if (unknownUnits) {
    warnings.push({
      code: 'unit_unknown',
      message: `Лист «${name}»: ${unknownUnits} строк с нераспознанной единицей измерения — сохранена как есть.`,
    });
  }

  return {
    sheet: name,
    sheet_index: sheetIndex,
    items,
    header: {
      row_index: header.row + 1,
      span: header.span,
      score: header.score,
      columns: Object.fromEntries(
        Object.entries(header.columns).map(([f, c]) => [f, { index: c, ref: encodeCell(header.row, c), label: header.labels[c] }]),
      ),
    },
    warnings,
    stats: { rows: grid.length, items: items.length, sections, totals, skipped },
  };
}

// ── Разбор книги (несколько листов) ──────────────────────────────────────────
function parseGrids(sheets, opts = {}) {
  const perSheet = [];
  const items = [];
  const warnings = [];
  (Array.isArray(sheets) ? sheets : []).forEach((sheet, i) => {
    const parsed = parseSheet({ ...sheet, index: Number.isFinite(sheet.index) ? sheet.index : i }, opts);
    perSheet.push(parsed);
    warnings.push(...parsed.warnings);
    for (const item of parsed.items) {
      items.push({ ...item, order_idx: items.length });
    }
  });
  return {
    items,
    sheets: perSheet.map((s) => ({
      sheet: s.sheet,
      sheet_index: s.sheet_index,
      header: s.header,
      stats: s.stats,
    })),
    warnings,
    stats: {
      sheets: perSheet.length,
      sheets_parsed: perSheet.filter((s) => s.header).length,
      items: items.length,
      with_quantity: items.filter((i) => i.quantity !== null).length,
      with_unit: items.filter((i) => i.unit).length,
      unknown_units: items.filter((i) => i.unit && !i.unit_known).length,
    },
  };
}

module.exports = {
  encodeCol,
  encodeCell,
  expandMerges,
  mapColumns,
  detectHeader,
  isNumberingRow,
  parseSheet,
  parseGrids,
  COLUMN_PATTERNS,
};
