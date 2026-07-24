'use strict';

// Каталог ВОР для LLM-стадии: позиции → компактные строки → ПАКЕТЫ под
// токенный бюджет.
//
// Раньше ВОР шёл в модель как «самая длинная ячейка каждой строки» и при
// превышении лимита символов ВЫБРАСЫВАЛСЯ из анализа целиком («ВОР пропущен»).
// Теперь: одинаковые позиции сворачиваются (объёмы суммируются), каталог
// печатается таблицей с единицами и количествами, а если он не влезает в один
// запрос — режется на ПАКЕТЫ, и стадия проходит по ним все до одного.

const { estimateTokens } = require('../stageAnalysis/shared/segmentation');
const { nameKey, normalizeText } = require('./vorNormalize');

// ── Каталог ──────────────────────────────────────────────────────────────────
function formatQuantity(q) {
  if (q === null || q === undefined || !Number.isFinite(q)) return '';
  const rounded = Math.round(q * 1000) / 1000;
  return String(rounded);
}

// Позиции с одинаковым наименованием И единицей — одна запись каталога:
// количества суммируются, номера позиций и координаты сохраняются.
function buildCatalog(items, opts = {}) {
  const maxRefs = opts.maxRefs || 5;
  const byKey = new Map();
  for (const it of Array.isArray(items) ? items : []) {
    const name = normalizeText(it.name);
    if (!name) continue;
    const unit = it.unit || '';
    const key = `${it.name_key || nameKey(name)}|${unit}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        key,
        name,
        name_key: it.name_key || nameKey(name),
        unit,
        unit_raw: it.unit_raw || '',
        quantity: null,
        section: it.section || '',
        positions: [],
        refs: [],
        count: 0,
      };
      byKey.set(key, entry);
    }
    entry.count += 1;
    if (typeof it.quantity === 'number' && Number.isFinite(it.quantity)) {
      entry.quantity = (entry.quantity || 0) + it.quantity;
    }
    if (it.position_no && entry.positions.length < maxRefs) entry.positions.push(it.position_no);
    if (entry.refs.length < maxRefs) {
      entry.refs.push({
        sheet: it.sheet_name || '',
        row: it.row_index || null,
        cell: (it.cells && it.cells.name) || null,
      });
    }
  }
  return [...byKey.values()];
}

// ВОР не таблицей (pdf/docx/txt): каждая содержательная строка — запись
// каталога. Никакой «самой длинной ячейки»: структуры нет — и мы её не выдумываем.
const HAS_LETTER = /[A-Za-zА-Яа-яЁё]/;
function buildCatalogFromText(text, opts = {}) {
  const minLen = opts.minLen || 4;
  const seen = new Set();
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const name = normalizeText(line);
    if (name.length < minLen || !HAS_LETTER.test(name)) continue;
    const key = nameKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      key: `${key}|`,
      name,
      name_key: key,
      unit: '',
      unit_raw: '',
      quantity: null,
      section: '',
      positions: [],
      refs: [],
      count: 1,
      from_text: true,
    });
  }
  return out;
}

// ── Рендер ───────────────────────────────────────────────────────────────────
const TABLE_HEADER = ['| № | Наименование работ (ВОР) | Ед. | Кол-во |', '|---|---|---|---|'];

function entryRow(entry) {
  const pos = entry.positions.length ? entry.positions.join(', ') : '—';
  const name = entry.name.replace(/\|/g, '/');
  return `| ${pos} | ${name} | ${entry.unit || '—'} | ${formatQuantity(entry.quantity) || '—'} |`;
}

// Таблица каталога, сгруппированная по разделам ВОР (раздел печатается один
// раз строкой-подзаголовком — это дешевле, чем колонка в каждой строке).
function renderCatalog(entries) {
  const lines = [];
  let section = null;
  let opened = false;
  for (const e of entries) {
    const s = e.section || '';
    if (s !== section) {
      section = s;
      if (s) lines.push('', `**Раздел ВОР: ${s}**`);
      opened = false;
    }
    if (!opened) {
      lines.push(...TABLE_HEADER);
      opened = true;
    }
    lines.push(entryRow(e));
  }
  return lines.join('\n').trim();
}

const entryTokens = (e) => estimateTokens(entryRow(e)) + 2;

// ── Пакеты под токенный бюджет ───────────────────────────────────────────────
// Большой ВОР не «пропускается», а режется на пакеты: стадия обойдёт их все.
const DEFAULT_BATCH_TOKENS = Number(process.env.STAGE1_VOR_BATCH_TOKENS) || 6000;

function packCatalog(entries, opts = {}) {
  const budget = Math.max(500, Number(opts.budgetTokens) || DEFAULT_BATCH_TOKENS);
  const list = Array.isArray(entries) ? entries : [];
  const batches = [];
  let cur = [];
  let curTokens = 0;
  for (const e of list) {
    const t = entryTokens(e);
    if (cur.length && curTokens + t > budget) {
      batches.push(cur);
      cur = [];
      curTokens = 0;
    }
    cur.push(e);
    curTokens += t;
  }
  if (cur.length) batches.push(cur);
  return batches.map((items, index) => ({
    index,
    total: batches.length,
    entries: items,
    tokens: items.reduce((n, e) => n + entryTokens(e), 0),
    positions: items.reduce((n, e) => n + e.count, 0),
  }));
}

// Текст пакета для промта. Явно сообщаем модели, что перед ней ЧАСТЬ ведомости
// (иначе она сочтёт отсутствие работы в пакете доказательством отсутствия в ВОР;
// решение о «нет в ВОР» принимается только после всех пакетов — см. stage1_llm).
function renderBatch(batch, meta = {}) {
  const head = [];
  const total = batch.total || 1;
  if (total > 1) {
    head.push(
      `> ВОР приведён ЧАСТЯМИ. Это часть ${batch.index + 1}/${total} ` +
        `(${batch.positions} позиций из ${meta.totalPositions || '?'}). Остальные части ведомости ` +
        'показываются отдельно — не делай вывода «работы нет в ВОР» по одной части: ' +
        'сервер сведёт результаты всех частей сам.',
    );
  }
  if (meta.filtered) {
    head.push(
      `> Показаны ${meta.shown} позиций ВОР из ${meta.totalEntries}, отобранных по совпадению ` +
        'терминов с этой частью ТЗ (остальные к ней заведомо не относятся).',
    );
  }
  if (meta.sourceNote) head.push(`> ${meta.sourceNote}`);
  const body = renderCatalog(batch.entries);
  return [...head, head.length ? '' : null, body].filter((x) => x !== null).join('\n');
}

function catalogStats(entries) {
  const list = Array.isArray(entries) ? entries : [];
  return {
    entries: list.length,
    positions: list.reduce((n, e) => n + e.count, 0),
    tokens: list.reduce((n, e) => n + entryTokens(e), 0),
    with_quantity: list.filter((e) => e.quantity !== null).length,
    units: [...new Set(list.map((e) => e.unit).filter(Boolean))],
  };
}

module.exports = {
  DEFAULT_BATCH_TOKENS,
  buildCatalog,
  buildCatalogFromText,
  renderCatalog,
  renderBatch,
  packCatalog,
  entryRow,
  entryTokens,
  formatQuantity,
  catalogStats,
};
