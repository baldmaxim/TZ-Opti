'use strict';

// Структурированный вход сопоставления ТЗ ↔ ВОР ↔ чек-лист.
//
// Задача трёх источников: ТЗ говорит, ЧТО требуется; ВОР — что ГП посчитал;
// чек-лист — что ГП вообще выполняет. Раньше их сводила только модель, получая
// ВОР «плоским списком строк» (а на больших ведомостях — не получая вовсе).
//
// Здесь детерминированный слой ПОД моделью:
//   • лексический индекс с IDF по позициям ВОР и работам чек-листа;
//   • для куска ТЗ — КАНДИДАТЫ из ВОР/чек-листа (чтобы в промт шло релевантное,
//     а не вся ведомость);
//   • перекрёстная сверка чек-лист ↔ ВОР (работа в объёме, но не посчитана —
//     и наоборот) как готовый факт, а не как догадка модели.
//
// Чистый модуль: без БД, без сети.

const { nameKey } = require('./vorNormalize');

// Служебные слова строительных наименований: встречаются почти в каждой
// позиции и ничего не различают.
const STOPWORDS = new Set([
  'и', 'в', 'во', 'на', 'с', 'со', 'по', 'для', 'из', 'не', 'от', 'до', 'при', 'к', 'ко',
  'а', 'или', 'же', 'то', 'что', 'как', 'это', 'все', 'том', 'числе', 'т', 'п', 'др',
  'шт', 'м', 'мм', 'см', 'кг', 'мп', 'ед', 'изм', 'кол', 'во', 'итого', 'всего',
  'работы', 'работ', 'работа', 'устройство', 'выполнение', 'прочие', 'прочих',
]);

const MIN_TOKEN_LEN = 3;
const STEM_LEN = 6;

// Лёгкая нормализация словоформы: снимаем типовое русское окончание, затем
// усекаем до STEM_LEN. Полноценный стеммер здесь избыточен — нужно лишь свести
// формы одного слова к общему ключу («кладка»/«кладке» → «кладк»,
// «наружных»/«наружной» → «наружн», «сетей»/«сети» → «сет»).
const ENDINGS = [
  'ами', 'ями', 'ому', 'ему', 'ого', 'его', 'ыми', 'ими',
  'ая', 'яя', 'ое', 'ее', 'ые', 'ие', 'ых', 'их', 'ой', 'ей', 'ом', 'ем',
  'ам', 'ям', 'ах', 'ях', 'ую', 'юю', 'ов', 'ев', 'ью', 'ия', 'ии', 'ый', 'ий',
  'а', 'я', 'о', 'е', 'ы', 'и', 'у', 'ю', 'ь', 'й',
];
const MIN_STEM = 3;

function stemToken(token) {
  let t = token;
  for (const end of ENDINGS) {
    if (t.length - end.length >= MIN_STEM && t.endsWith(end)) {
      t = t.slice(0, -end.length);
      break;
    }
  }
  return t.length > STEM_LEN ? t.slice(0, STEM_LEN) : t;
}

function stems(text) {
  const norm = nameKey(text);
  if (!norm) return [];
  const out = [];
  for (const raw of norm.split(/[^0-9a-zа-я]+/)) {
    if (!raw || raw.length < MIN_TOKEN_LEN) continue;
    if (STOPWORDS.has(raw)) continue;
    // Чистые числа сохраняем целиком: «200», «25» — толщина/диаметр/марка.
    out.push(/^\d+$/.test(raw) ? raw : stemToken(raw));
  }
  return out;
}

const stemSet = (text) => new Set(stems(text));

// ── Индекс ───────────────────────────────────────────────────────────────────
function idfMap(docs) {
  const df = new Map();
  for (const set of docs) {
    for (const s of set) df.set(s, (df.get(s) || 0) + 1);
  }
  const n = Math.max(1, docs.length);
  const idf = new Map();
  for (const [s, c] of df) idf.set(s, Math.log(1 + n / c));
  return idf;
}

function weightOf(set, idf) {
  let w = 0;
  for (const s of set) w += idf.get(s) || 1;
  return w;
}

// vorEntries — записи каталога (vorCatalog.buildCatalog), checklist — строки
// work_checklist_items. Возвращает индекс для scoring'а и перекрёстной сверки.
function buildMatchIndex({ vorEntries = [], checklist = [] } = {}) {
  const vor = vorEntries.map((entry, i) => ({ i, entry, set: stemSet(entry.name) }));
  const cl = checklist.map((row, i) => ({
    i,
    row,
    name: row.work_name || '',
    set: stemSet(row.work_name || ''),
  }));
  const idf = idfMap([...vor.map((v) => v.set), ...cl.map((c) => c.set)]);
  for (const v of vor) v.weight = weightOf(v.set, idf) || 1;
  for (const c of cl) c.weight = weightOf(c.set, idf) || 1;
  return { vor, checklist: cl, idf };
}

// Доля значащих слов записи, встретившихся в тексте: 1.0 — в тексте есть все
// слова позиции ВОР, 0 — ни одного. Слова НЕ взвешиваются по IDF намеренно:
// иначе одно уникальное уточнение («в осях 1-5», «толщ. 200 мм») перевешивало
// бы совпадение по сути и выбрасывало позицию из кандидатов — а цена ошибки
// здесь несимметрична: лишняя показанная позиция стоит токенов, пропущенная
// даёт ЛОЖНОЕ «работы нет в ВОР». IDF идёт в ранжирование (weightedScore).
function coverage(docSet, querySet) {
  if (!docSet.size) return 0;
  let hit = 0;
  for (const s of docSet) {
    if (querySet.has(s)) hit += 1;
  }
  return hit / docSet.size;
}

// Взвешенная по IDF версия — только для сортировки кандидатов: чем реже слово,
// тем «специфичнее» совпадение, такие позиции показываем первыми.
function weightedScore(docSet, docWeight, querySet, idf) {
  if (!docSet.size) return 0;
  let hit = 0;
  for (const s of docSet) {
    if (querySet.has(s)) hit += idf.get(s) || 1;
  }
  return hit / (docWeight || 1);
}

const DEFAULT_MIN_SCORE = 0.4;

// Кандидаты из ВОР и чек-листа для куска ТЗ.
function selectCandidates(index, text, opts = {}) {
  const minScore = opts.minScore == null ? DEFAULT_MIN_SCORE : opts.minScore;
  const limit = opts.limit || Infinity;
  const q = stemSet(text);
  const rank = (list) => list
    .map((d) => ({ ...d, score: coverage(d.set, q), rank: weightedScore(d.set, d.weight, q, index.idf) }))
    .filter((d) => d.score >= minScore)
    .sort((a, b) => b.rank - a.rank || a.i - b.i)
    .slice(0, limit);
  return { vor: rank(index.vor), checklist: rank(index.checklist), queryTerms: q.size };
}

// ── Перекрёстная сверка чек-лист ↔ ВОР ───────────────────────────────────────
// Симметричное сходство: обе записи должны «узнать» друг друга, иначе
// «Монтаж окон» слипнется с «Монтаж окон и витражей алюминиевых» произвольно.
function similarity(a, b) {
  return Math.min(coverage(a.set, b.set), coverage(b.set, a.set));
}

const LINK_MIN_SCORE = 0.5;

function crossReference(index, opts = {}) {
  const minScore = opts.minScore == null ? LINK_MIN_SCORE : opts.minScore;
  const links = [];
  const matchedVor = new Set();
  for (const c of index.checklist) {
    let best = null;
    for (const v of index.vor) {
      const s = similarity(c, v);
      if (s >= minScore && (!best || s > best.score)) best = { v, score: s };
    }
    if (best) matchedVor.add(best.v.i);
    links.push({
      checklist_id: c.row.id || null,
      work_name: c.name,
      in_calc: c.row.in_calc === null || c.row.in_calc === undefined ? null : Number(c.row.in_calc),
      vor: best
        ? {
          name: best.v.entry.name,
          unit: best.v.entry.unit,
          quantity: best.v.entry.quantity,
          positions: best.v.entry.positions,
          refs: best.v.entry.refs,
        }
        : null,
      score: best ? Math.round(best.score * 100) / 100 : 0,
    });
  }
  // Работа в объёме ГП (in_calc=1), но в ведомости не найдена — расхождение
  // «чек-лист ↔ смета» (problem_type=не_учтено_в_вор), готовый факт для стадии 1.
  const inCalcNotInVor = links.filter((l) => l.in_calc === 1 && !l.vor).map((l) => l.work_name);
  return {
    links,
    in_calc_without_vor: inCalcNotInVor,
    vor_without_checklist: index.vor.filter((v) => !matchedVor.has(v.i)).length,
    matched: links.filter((l) => l.vor).length,
    checklist_total: index.checklist.length,
    vor_total: index.vor.length,
  };
}

// ── Готовый вход сопоставления для одного куска ТЗ ───────────────────────────
// Возвращает ОДНУ структуру, из которой стадия собирает промт: какие позиции
// ВОР и работы чек-листа относятся к этому куску ТЗ, и было ли сужение.
function buildMatchingInput(index, tzText, opts = {}) {
  const all = index.vor.map((v) => v.entry);
  const { vor, checklist } = selectCandidates(index, tzText, opts);
  const relevant = vor.map((v) => v.entry);
  return {
    vor: {
      entries: relevant,
      all_entries: all,
      total: all.length,
      selected: relevant.length,
    },
    checklist: {
      candidates: checklist.map((c) => ({ work_name: c.name, in_calc: c.row.in_calc, score: c.score })),
      total: index.checklist.length,
    },
  };
}

module.exports = {
  STOPWORDS,
  stems,
  stemSet,
  buildMatchIndex,
  selectCandidates,
  crossReference,
  similarity,
  coverage,
  weightedScore,
  buildMatchingInput,
  DEFAULT_MIN_SCORE,
  LINK_MIN_SCORE,
};
