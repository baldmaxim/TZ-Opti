'use strict';

// СОПОСТАВЛЕНИЕ находки агента с эталонным замечанием benchmark-набора.
//
// Замечание агента считается совпавшим с эталонным НЕ по текстовому равенству
// формулировок, а по четырём осям (веса — WEIGHTS):
//   place    — место в документе: пересечение цитат, абзац, номер пункта;
//   meaning  — смысл: лексическая близость к допустимым формулировкам эталона
//              + совпадение объекта работ (таксономия topicModel);
//   category — категория риска: пересечение семейств RISK_FAMILIES или
//              нормализованных значений problem_type / risk_category;
//   action   — направление рекомендуемого действия (amend_tz и exclude_scope —
//              разные направления; ask_customer и add_assumption — одно).
// Совпадение = взвешенная сумма ≥ MATCH_THRESHOLD И place ≥ PLACE_GATE:
// без привязки к месту документа замечание не может закрыть эталон.
//
// Чистый модуль: без БД, без сети, без LLM. Тестируется офлайн
// (server/test/unit/benchmark/matcher.test.js).

const {
  normalizeRu,
  stemSet,
  similarity,
  detectWorkObject,
  RISK_FAMILIES,
} = require('../clustering/topicModel');
const { normalizeRequiredAction, normalizeVerdict } = require('../review/materiality');

const WEIGHTS = Object.freeze({ place: 0.4, meaning: 0.3, category: 0.2, action: 0.1 });
const MATCH_THRESHOLD = 0.6;
const PLACE_GATE = 0.5;
const MEANING_GATE = 0.35;

// Направление действия: правка текста ≠ вынос из объёма, а вопрос заказчику и
// допущение в КП — одно направление «уточнить прежде чем считать».
const ACTION_DIRECTION = Object.freeze({
  amend_tz: 'change_text',
  exclude_scope: 'reduce_scope',
  ask_customer: 'clarify',
  add_assumption: 'clarify',
  recalculate: 'recalculate',
  none: 'none',
});

// --- Документ ----------------------------------------------------------------

// Абзац = непустая строка Markdown (пункты синтетических ТЗ и строки таблиц
// пишутся в одну строку). paragraph_index в findings-файлах — в ЭТОЙ системе
// координат (нумерация непустых строк с нуля).
function prepareDocument(sourceText) {
  const paragraphs = [];
  for (const line of String(sourceText == null ? '' : sourceText).split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw) continue;
    const norm = normalizeRu(raw);
    if (!norm) continue;
    paragraphs.push({ raw, norm, stems: stemSet(raw) });
  }
  return { paragraphs, fullNorm: paragraphs.map((p) => p.norm).join('\n') };
}

// Доля основ меньшего множества, покрытая большим: устойчива к «цитата агента —
// кусок эталонной цитаты» и наоборот.
function containment(a, b) {
  if (!a || !b || !a.size || !b.size) return 0;
  let inter = 0;
  for (const s of a) if (b.has(s)) inter += 1;
  return inter / Math.min(a.size, b.size);
}

const LOCATE_MIN_CONTAINMENT = 0.7;

// Абзац, в котором находится цитата: сперва дословно (по нормализованному
// тексту), затем по покрытию основ. null — цитаты в документе нет.
function locateQuote(doc, quote) {
  const qNorm = normalizeRu(quote);
  if (!qNorm) return null;
  for (let i = 0; i < doc.paragraphs.length; i += 1) {
    if (doc.paragraphs[i].norm.includes(qNorm)) return { index: i, exact: true };
  }
  const qStems = stemSet(quote);
  let best = null;
  for (let i = 0; i < doc.paragraphs.length; i += 1) {
    const c = containment(qStems, doc.paragraphs[i].stems);
    if (c >= LOCATE_MIN_CONTAINMENT && (!best || c > best.containment)) {
      best = { index: i, exact: false, containment: c };
    }
  }
  return best;
}

// «п. 3.2», «3.2.», «3)2» → каноничный ключ пункта «3.2».
function clauseKey(text) {
  const m = String(text == null ? '' : text).match(/\d+(?:[.)]\d+)*/);
  if (!m) return null;
  return m[0].replace(/\)/g, '.').replace(/\.+$/, '');
}

// Ключи категории: нормализованные significant-значения + семейства рисков.
// Пересечение ключей двух сторон = категория совпала (семейство ловит
// свободные формулировки: «не_учтено_в_вор» и «отсутствует в ВОР» — одно).
function categoryKeys(problemType, riskCategory) {
  const keys = new Set();
  for (const value of [problemType, riskCategory]) {
    const norm = normalizeRu(value);
    if (!norm || norm === 'general') continue;
    keys.add(norm.replace(/\s+/g, '_'));
    for (const [re, family] of RISK_FAMILIES) {
      if (re.test(norm)) keys.add(family);
    }
  }
  return keys;
}

// --- Нормализация сторон -----------------------------------------------------

// Находка агента-кандидата (одна строка findings-файла) → рабочий вид.
function prepareFinding(raw, index, doc) {
  const quote = String(raw.quote || raw.source_fragment || '').trim();
  const summary = String(raw.summary || raw.title || raw.text || '').trim();
  const basis = String(raw.basis || '').trim();
  const located = locateQuote(doc, quote);
  const qNorm = normalizeRu(quote);
  const anchored = !!qNorm && (located != null || doc.fullNorm.includes(qNorm));
  const text = [summary, basis].filter(Boolean).join(' ') || quote;
  let published = true;
  if (raw.published != null) published = !!raw.published;
  else if (raw.verdict != null) published = normalizeVerdict(raw.verdict) === 'publish';
  return {
    id: String(raw.id || `finding-${index + 1}`),
    stage: raw.stage == null ? null : raw.stage,
    rank: Number.isFinite(Number(raw.rank)) ? Number(raw.rank) : index + 1,
    quote,
    summary,
    basis,
    text,
    textStems: stemSet(text),
    quoteStems: stemSet(quote),
    paragraph: located ? located.index
      : (Number.isInteger(raw.paragraph_index) ? raw.paragraph_index : null),
    clause: clauseKey(raw.tz_clause),
    categories: categoryKeys(raw.problem_type, raw.risk_category || raw.category),
    action: raw.required_action == null || raw.required_action === ''
      ? null
      : normalizeRequiredAction(raw.required_action),
    impact_level: raw.impact_level || null,
    impact_dimensions: raw.impact_dimensions == null ? [] : raw.impact_dimensions,
    anchored,
    published,
    workObject: detectWorkObject([summary, basis, quote].filter(Boolean).join(' ')),
  };
}

// Эталонное (ожидаемое) замечание gold-файла → рабочий вид.
function prepareExpected(item, doc) {
  const quote = String(item.quote || '').trim();
  const phrasings = Array.isArray(item.accepted_phrasings)
    ? item.accepted_phrasings.filter(Boolean)
    : [];
  const located = locateQuote(doc, quote);
  const targets = phrasings.length ? phrasings : [quote];
  return {
    id: String(item.id),
    kind: item.kind,
    quote,
    phrasings,
    targetStems: targets.map((t) => stemSet(t)),
    paragraph: located ? located.index : null,
    quoteStems: stemSet(quote),
    clause: clauseKey(item.tz_clause || ''),
    categories: categoryKeys(item.problem_type, item.risk_category),
    action: item.required_action ? normalizeRequiredAction(item.required_action) : null,
    expected_impact: item.expected_impact || null,
    required_basis: item.required_basis || null,
    engineer_comment: item.engineer_comment || null,
    workObject: detectWorkObject([...phrasings, quote].filter(Boolean).join(' ')),
  };
}

// Запрещённое к публикации замечание gold-файла. Категория и действие у него
// нейтральны (0.5): запрет определяется местом и смыслом формулировки.
function prepareForbidden(item, doc) {
  const quote = String(item.quote || '').trim();
  const phrasings = Array.isArray(item.accepted_phrasings)
    ? item.accepted_phrasings.filter(Boolean)
    : [];
  const located = locateQuote(doc, quote);
  const targets = phrasings.length ? phrasings : [quote];
  return {
    id: String(item.id),
    reason: item.reason || null,
    quote,
    phrasings,
    targetStems: targets.map((t) => stemSet(t)),
    paragraph: located ? located.index : null,
    quoteStems: stemSet(quote),
    clause: null,
    categories: new Set(),
    action: null,
    engineer_comment: item.engineer_comment || null,
    workObject: detectWorkObject([...phrasings, quote].filter(Boolean).join(' ')),
  };
}

// --- Оси ---------------------------------------------------------------------

function placeScore(finding, target) {
  let score = 0;
  const c = containment(finding.quoteStems, target.quoteStems);
  if (c >= 0.7) score = 1;
  else if (c >= 0.4) score = Math.max(score, 0.7);
  if (finding.paragraph != null && target.paragraph != null) {
    const d = Math.abs(finding.paragraph - target.paragraph);
    if (d === 0) score = Math.max(score, 1);
    else if (d === 1) score = Math.max(score, 0.6);
  }
  if (finding.clause && target.clause && finding.clause === target.clause) {
    score = Math.max(score, 0.8);
  }
  return score;
}

function meaningScore(finding, target) {
  let jac = 0;
  for (const t of target.targetStems) {
    jac = Math.max(jac, similarity(finding.textStems, t));
  }
  // Совпавший объект работ — смысловое подтверждение сильнее пересечения слов
  // (та же логика, что в ярусе 2 кластеризации: формулировки одной обязанности
  // пересекаются словами плохо).
  if (finding.workObject && target.workObject && finding.workObject.id === target.workObject.id) {
    return Math.max(jac, 0.8);
  }
  return jac;
}

function categoryScore(finding, target) {
  if (!finding.categories.size || !target.categories.size) return 0.5;
  for (const key of finding.categories) {
    if (target.categories.has(key)) return 1;
  }
  return 0;
}

function actionScore(finding, target) {
  if (!finding.action || !target.action) return 0.5;
  const df = ACTION_DIRECTION[finding.action] || finding.action;
  const dt = ACTION_DIRECTION[target.action] || target.action;
  return df === dt ? 1 : 0;
}

const round4 = (n) => Number(n.toFixed(4));

function matchScore(finding, target) {
  const axes = {
    place: placeScore(finding, target),
    meaning: meaningScore(finding, target),
    category: categoryScore(finding, target),
    action: actionScore(finding, target),
  };
  const score = round4(
    WEIGHTS.place * axes.place
    + WEIGHTS.meaning * axes.meaning
    + WEIGHTS.category * axes.category
    + WEIGHTS.action * axes.action,
  );
  return {
    score,
    axes,
    eligible: score >= MATCH_THRESHOLD && axes.place >= PLACE_GATE,
  };
}

// Причины несовпадения пары — по осям, проваленным относительно порогов.
function failedAxes(axes, score) {
  const reasons = [];
  if (axes.place < PLACE_GATE) reasons.push('place_mismatch');
  if (axes.meaning < MEANING_GATE) reasons.push('meaning_mismatch');
  if (axes.category === 0) reasons.push('category_mismatch');
  if (axes.action === 0) reasons.push('action_mismatch');
  if (!reasons.length && score < MATCH_THRESHOLD) reasons.push('below_threshold');
  return reasons;
}

module.exports = {
  WEIGHTS,
  MATCH_THRESHOLD,
  PLACE_GATE,
  MEANING_GATE,
  ACTION_DIRECTION,
  prepareDocument,
  containment,
  locateQuote,
  clauseKey,
  categoryKeys,
  prepareFinding,
  prepareExpected,
  prepareForbidden,
  placeScore,
  meaningScore,
  categoryScore,
  actionScore,
  matchScore,
  failedAxes,
};
