'use strict';

// Каталог ВОР для LLM-стадии: позиции → компактные строки → ПАКЕТЫ под
// токенный бюджет.
//
// Раньше ВОР шёл в модель как «самая длинная ячейка каждой строки» и при
// превышении лимита символов ВЫБРАСЫВАЛСЯ из анализа целиком («ВОР пропущен»).
// Теперь: одинаковые позиции сворачиваются (объёмы суммируются) — строго в
// пределах ОДНОГО документа ВОР, — каталог печатается таблицей с единицами,
// количествами и стабильным ID записи, а если он не влезает в один запрос —
// режется на ПАКЕТЫ, и стадия проходит по ним все до одного.

const crypto = require('crypto');
const { estimateTokens } = require('../stageAnalysis/shared/segmentation');
const { nameKey, normalizeText } = require('./vorNormalize');

// ── Каталог ──────────────────────────────────────────────────────────────────
function formatQuantity(q) {
  if (q === null || q === undefined || !Number.isFinite(q)) return '';
  const rounded = Math.round(q * 1000) / 1000;
  return String(rounded);
}

// Стабильный идентификатор записи каталога: документ + лист + строка Excel
// ПЕРВОГО вхождения. Переживает прогоны и пакетирование; модель ссылается на
// позицию по нему (catalog_entry_id в vor_match), сервер детерминированно
// находит запись при сверке (requirementMatchModel.resolvePositions).
function catalogEntryId(documentId, sheetName, rowIndex) {
  const raw = `${documentId || ''}|${sheetName || ''}|${rowIndex == null ? '' : rowIndex}`;
  return `vc_${crypto.createHash('sha1').update(raw).digest('hex').slice(0, 10)}`;
}

// Позиции с одинаковым наименованием И единицей — одна запись каталога,
// НО только В ПРЕДЕЛАХ ОДНОГО ДОКУМЕНТА ВОР: в тендере живёт несколько
// актуальных ведомостей (корпус 1, корпус 2, …), и «перегородки 5 000 м²»
// корпуса 1 нельзя складывать с «перегородками 7 000 м²» корпуса 2 — требование
// ТЗ может относиться только к одному корпусу. opts.documents
// ([{id, name, revision_label, applicability}]) размечает записи метаданными
// манифеста; агрегирование поверх документов — только как отдельная аналитика,
// исходные связи не теряются.
function buildCatalog(items, opts = {}) {
  const maxRefs = opts.maxRefs || 5;
  const docs = new Map(
    (Array.isArray(opts.documents) ? opts.documents : [])
      .filter((d) => d && d.id)
      .map((d) => [d.id, d]),
  );
  const byKey = new Map();
  for (const it of Array.isArray(items) ? items : []) {
    const name = normalizeText(it.name);
    if (!name) continue;
    const unit = it.unit || '';
    const docId = it.document_id || null;
    const key = `${docId || ''}|${it.name_key || nameKey(name)}|${unit}`;
    let entry = byKey.get(key);
    if (!entry) {
      const doc = docId ? docs.get(docId) : null;
      entry = {
        key,
        entry_id: catalogEntryId(docId, it.sheet_name, it.row_index),
        document_id: docId,
        document_name: (doc && doc.name) || '',
        applicability: (doc && doc.applicability) || '',
        revision_label: (doc && doc.revision_label) || '',
        sheet: it.sheet_name || '',
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
      key: `|${key}|`,
      entry_id: catalogEntryId(null, 'text', key),
      document_id: null,
      document_name: '',
      applicability: '',
      revision_label: '',
      sheet: '',
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
const TABLE_HEADER = ['| ID | № | Наименование работ (ВОР) | Ед. | Кол-во |', '|---|---|---|---|---|'];

function entryRow(entry) {
  const pos = entry.positions.length ? entry.positions.join(', ') : '—';
  const name = entry.name.replace(/\|/g, '/');
  return `| ${entry.entry_id || '—'} | ${pos} | ${name} | ${entry.unit || '—'} | ${formatQuantity(entry.quantity) || '—'} |`;
}

function documentHeader(entry) {
  const meta = [];
  if (entry.applicability) meta.push(`применимость: ${entry.applicability}`);
  if (entry.revision_label) meta.push(`редакция: ${entry.revision_label}`);
  const suffix = meta.length ? ` (${meta.join('; ')})` : '';
  return `**Документ ВОР: ${entry.document_name || 'без названия'}${suffix}**`;
}

// Таблица каталога: группировка по ДОКУМЕНТАМ ВОР (заголовок с применимостью и
// редакцией — модель обязана понимать, к какому корпусу относится позиция),
// внутри документа — по разделам (раздел печатается один раз
// строкой-подзаголовком — это дешевле, чем колонка в каждой строке).
function renderCatalog(entries) {
  const lines = [];
  let docId;
  let docStarted = false;
  let section = null;
  let opened = false;
  for (const e of entries) {
    const d = e.document_id || '';
    const hasDocMeta = Boolean(e.document_name || e.applicability || e.revision_label);
    if (hasDocMeta && (!docStarted || d !== docId)) {
      lines.push('', documentHeader(e));
      docStarted = true;
      section = null;
      opened = false;
    }
    docId = d;
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
    documents: new Set(list.map((e) => e.document_id).filter(Boolean)).size,
  };
}

module.exports = {
  DEFAULT_BATCH_TOKENS,
  catalogEntryId,
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
