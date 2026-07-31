'use strict';

// КАРТА СОПОСТАВЛЕНИЯ «требование ТЗ ↔ позиции ВОР» — ЧИСТОЕ ядро (без БД/LLM).
//
// Прежняя Стадия 1 отвечала бинарно («учтено / не учтено») и по лексике: позиция
// «Перегородки — 12 000 м²» гасила требование «устройство перегородок, усиление
// проёмов, закладные и заделка примыканий», хотя усиления/закладные/заделка в
// цену могли не попасть. Теперь каждое сопоставление — СТРУКТУРНАЯ СВЯЗЬ:
//   требование ТЗ → одна или несколько позиций ВОР → количество → единица →
//   включённые операции → недостающие операции → исключения → примечания по
//   единицам/коэффициентам/отходам → уверенность → подтверждение инженера.
//
// Разделение ответственности:
//   • модель ЗАЯВЛЯЕТ сопоставление (какие позиции, какие операции включены);
//   • СЕРВЕР детерминированно сверяет заявленные позиции с каталогом ведомости
//     (resolvePositions): количество и единица берутся ИЗ ВЕДОМОСТИ, а не со
//     слов модели; незнакомая позиция помечается verified=false;
//   • ИНЖЕНЕР подтверждает/отклоняет связь (requirement_match_confirmations,
//     переживает прогоны) — лексическая связь без подтверждения не считается
//     доказательством количественного покрытия.

const crypto = require('crypto');

const MATCH_STATUSES = Object.freeze(['covered', 'partial', 'not_covered', 'unclear']);
const CONFIRM_STATUSES = Object.freeze(['confirmed', 'rejected', 'adjusted']);

const STATUS_LABELS = Object.freeze({
  covered: 'Покрыто',
  partial: 'Покрыто частично',
  not_covered: 'Не покрыто',
  unclear: 'Покрытие неясно',
});

const CONFIRM_LABELS = Object.freeze({
  confirmed: 'Подтверждено инженером',
  rejected: 'Отклонено инженером',
  adjusted: 'Скорректировано инженером',
});

function normalize(s) {
  return (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Стабильный ключ требования: хэш нормализованной цитаты. Переживает прогоны,
// пока формулировка требования в ТЗ не изменилась, — на нём держится
// подтверждение инженера.
function matchKeyOf(fragment) {
  return `rm_${crypto.createHash('sha1').update(normalize(fragment)).digest('hex').slice(0, 20)}`;
}

const asList = (v) => (Array.isArray(v) ? v.map((x) => String(x || '').trim()).filter(Boolean) : []);
const asText = (v) => {
  const s = String(v == null ? '' : v).trim();
  return s || null;
};

// Нормализация заявленного моделью сопоставления (vor_match находки).
// null — сопоставление не заявлено (находка без раскладки — это допустимо,
// карта просто не пополнится).
function normalizeVorMatch(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const status = MATCH_STATUSES.includes(String(raw.status || '').trim().toLowerCase())
    ? String(raw.status).trim().toLowerCase()
    : null;
  const positions = (Array.isArray(raw.positions) ? raw.positions : [])
    .map((p) => ({
      catalog_entry_id: asText(p && p.catalog_entry_id),
      position_no: asText(p && p.position_no),
      code: asText(p && p.code),
      name: asText(p && p.name),
      quantity: Number.isFinite(Number(p && p.quantity)) ? Number(p.quantity) : null,
      unit: asText(p && p.unit),
    }))
    .filter((p) => p.catalog_entry_id || p.position_no || p.code || p.name);
  if (!status && !positions.length) return null;
  return {
    status: status || 'unclear',
    positions,
    operations_included: asList(raw.operations_included),
    operations_missing: asList(raw.operations_missing),
    exclusions: asList(raw.exclusions),
    unit_note: asText(raw.unit_note),
    quantity_note: asText(raw.quantity_note),
  };
}

// Детерминированная сверка заявленных позиций с КАТАЛОГОМ ведомости
// (vorCatalog.buildCatalog: entries с entry_id/document_*/name/unit/quantity/
// positions). Количество и единица в карте — ФАКТ ведомости; заявленное моделью
// значение, расходящееся с ведомостью, отмечается claimed_*. Не найденная в
// каталоге позиция остаётся в карте с verified=false — инженер видит, что связь
// не доказана ведомостью.
//
// Порядок разрешения: catalog_entry_id (стабильный ID записи каталога —
// однозначен даже при нескольких ВОР) → номер позиции → наименование. Номер
// позиции «1» существует в КАЖДОМ корпусе: при нескольких кандидатах без ID
// запись выбирается только если наименование её однозначно выделяет, иначе
// связь помечается ambiguous и НЕ приписывается произвольному документу.
function resolvePositions(match, vorEntries) {
  const entries = Array.isArray(vorEntries) ? vorEntries : [];
  const byId = new Map();
  const byNo = new Map();
  const byName = new Map();
  for (const e of entries) {
    if (e.entry_id) byId.set(String(e.entry_id).trim().toLowerCase(), e);
    for (const no of (e.positions || [])) {
      if (no == null || !String(no).trim()) continue;
      const k = String(no).trim().toLowerCase();
      if (!byNo.has(k)) byNo.set(k, []);
      byNo.get(k).push(e);
    }
    const nk = normalize(e.name);
    if (!byName.has(nk)) byName.set(nk, []);
    byName.get(nk).push(e);
  }

  // Совпадение засчитывается только ЕДИНСТВЕННОЕ: два кандидата (одна работа в
  // двух корпусах) — это неоднозначность, а не «берём первый попавшийся».
  const uniqueOnly = (list) => (list && list.length === 1 ? list[0] : null);
  const containsMatches = (nName, list) => {
    if (!nName || nName.length < 10) return [];
    return list.filter((e) => {
      const en = normalize(e.name);
      return en.includes(nName) || nName.includes(en);
    });
  };

  return (match.positions || []).map((p) => {
    const idKey = p.catalog_entry_id ? String(p.catalog_entry_id).trim().toLowerCase() : null;
    const nName = normalize(p.name);
    let entry = (idKey && byId.get(idKey)) || null;
    let ambiguous = false;
    if (!entry) {
      const noKey = p.position_no ? String(p.position_no).trim().toLowerCase() : null;
      const candidates = (noKey && byNo.get(noKey)) || [];
      if (candidates.length === 1) {
        entry = candidates[0];
      } else if (candidates.length > 1) {
        entry = uniqueOnly(candidates.filter((e) => normalize(e.name) === nName))
          || uniqueOnly(containsMatches(nName, candidates));
        ambiguous = !entry;
      }
    }
    if (!entry && !ambiguous) {
      const exact = byName.get(nName) || [];
      const contains = containsMatches(nName, entries);
      entry = uniqueOnly(exact) || uniqueOnly(contains);
      ambiguous = !entry && (exact.length > 1 || contains.length > 1);
    }
    if (!entry) {
      const out = { ...p, verified: false, unit_mismatch: null };
      // Позиция существует в нескольких документах ВОР, и ни ID, ни
      // наименование не выделяют один из них — произвольный документ не
      // подставляем, связь остаётся недоказанной.
      if (ambiguous) out.ambiguous = true;
      return out;
    }
    const unitMismatch = Boolean(p.unit && entry.unit && normalize(p.unit) !== normalize(entry.unit));
    const quantityMismatch = p.quantity != null && entry.quantity != null
      && Math.abs(p.quantity - entry.quantity) > Math.abs(entry.quantity) * 0.005;
    return {
      catalog_entry_id: entry.entry_id || null,
      document_id: entry.document_id || null,
      document_name: entry.document_name || null,
      applicability: entry.applicability || null,
      position_no: p.position_no || (entry.positions && entry.positions[0]) || null,
      code: p.code || entry.code || null,
      name: entry.name,
      // Факты ведомости — источник истины по числам.
      quantity: entry.quantity ?? null,
      unit: entry.unit || null,
      claimed_quantity: quantityMismatch ? p.quantity : null,
      claimed_unit: unitMismatch ? p.unit : null,
      unit_mismatch: unitMismatch,
      verified: true,
    };
  });
}

// Строка карты сопоставления из находки стадии (после normalizeVorMatch +
// resolvePositions). segmentIndex — из какой части ТЗ пришло.
function buildMatchRow({ fragment, sectionPath = null, match, resolvedPositions, confidence = null, problemType = null, segmentIndex = null }) {
  return {
    match_key: matchKeyOf(fragment),
    requirement_fragment: String(fragment || '').trim(),
    section_path: sectionPath || null,
    coverage_status: match.status,
    problem_type: problemType || null,
    positions: resolvedPositions,
    operations_included: match.operations_included,
    operations_missing: match.operations_missing,
    exclusions: match.exclusions,
    unit_note: match.unit_note,
    quantity_note: match.quantity_note,
    confidence: Number.isFinite(Number(confidence)) ? Number(confidence) : null,
    segment_index: segmentIndex,
  };
}

// Дедуп строк карты между частями/проходами: одно требование (match_key) — одна
// строка; при повторе побеждает более «тревожный» статус (not_covered > partial >
// unclear > covered), позиции объединяются по (position_no|name).
const STATUS_RANK = { not_covered: 3, partial: 2, unclear: 1, covered: 0 };

function mergeMatchRows(rows) {
  const byKey = new Map();
  for (const r of rows || []) {
    const prev = byKey.get(r.match_key);
    if (!prev) {
      byKey.set(r.match_key, { ...r });
      continue;
    }
    if ((STATUS_RANK[r.coverage_status] || 0) > (STATUS_RANK[prev.coverage_status] || 0)) {
      prev.coverage_status = r.coverage_status;
      prev.problem_type = r.problem_type || prev.problem_type;
    }
    // catalog_entry_id в ключе: одинаковые «позиция 1 / перегородки» из РАЗНЫХ
    // документов ВОР — разные связи, их нельзя схлопывать в одну.
    const posKey = (p) => `${p.catalog_entry_id || ''}|${p.position_no || ''}|${normalize(p.name)}`;
    const seen = new Set(prev.positions.map(posKey));
    for (const p of r.positions) {
      const k = posKey(p);
      if (!seen.has(k)) { prev.positions.push(p); seen.add(k); }
    }
    const uniq = (a, b) => [...new Set([...(a || []), ...(b || [])])];
    prev.operations_included = uniq(prev.operations_included, r.operations_included);
    prev.operations_missing = uniq(prev.operations_missing, r.operations_missing);
    prev.exclusions = uniq(prev.exclusions, r.exclusions);
    prev.unit_note = prev.unit_note || r.unit_note;
    prev.quantity_note = prev.quantity_note || r.quantity_note;
    if (r.confidence != null) {
      prev.confidence = prev.confidence == null ? r.confidence : Math.min(prev.confidence, r.confidence);
    }
  }
  return [...byKey.values()];
}

module.exports = {
  MATCH_STATUSES,
  CONFIRM_STATUSES,
  STATUS_LABELS,
  CONFIRM_LABELS,
  matchKeyOf,
  normalizeVorMatch,
  resolvePositions,
  buildMatchRow,
  mergeMatchRows,
};
