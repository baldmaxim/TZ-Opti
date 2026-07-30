'use strict';

// Оценочная карта замечания для precision-критика — 9 измерений, по которым
// решается судьба draft_issue. Чистый модуль: без БД, без LLM, без сети.
//
// Зачем 9 измерений вместо одного балла. Прежний critic начислял эвристические
// баллы и публиковал почти всё, что набрало «medium»: замечание с одним слабым
// признаком выглядело так же, как противоречие ВОР. Здесь оценка разложена на
// независимые оси, и каждая может САМА заблокировать публикацию:
//
//   evidence_strength    — чем подтверждено (цитата ТЗ, обоснование, несколько
//                          независимых стадий) — strong|medium|weak|none;
//   business_consequence — что ГП потеряет, если не заметить — critical..none;
//   actionability        — можно ли с этим что-то СДЕЛАТЬ (правка / вынос из
//                          объёма / вопрос заказчику) — actionable|conditional|none;
//   novelty              — новое замечание или повтор уже вынесенного —
//                          novel|partial_duplicate|duplicate;
//   scope/cost/schedule/contract/responsibility_impact — по каким каналам бьёт.
//
// Базовая (детерминированная) карта считается ЗДЕСЬ из уже посчитанного вердикта
// материальности (criticService.evaluateDraft): веса сработавших критериев
// компании, структура находки, предложенное действие. LLM-критик может её
// УТОЧНИТЬ для спорных случаев, но не заменить: см. precision/index.js.
//
// Чего в карте НЕТ намеренно: confidence исходного агента и его criticality.
// Высокая уверенность агента — не основание публикации (агент уверен в том, что
// ПРОЧИТАЛ, а не в том, что это дорого).

const { ASSUMPTION_RE, EDITORIAL_RE, STANDARD_REQUIREMENT_RE, INFORMATIONAL_RE } = require('./patterns');
const { actionFamily, canonicalAction, ACTIONS, FAMILY } = require('../../analysis/actions');

// --- Словари -----------------------------------------------------------------

const EVIDENCE_STRENGTH = Object.freeze(['strong', 'medium', 'weak', 'none']);
const BUSINESS_CONSEQUENCE = Object.freeze(['critical', 'high', 'medium', 'low', 'none']);
const ACTIONABILITY = Object.freeze(['actionable', 'conditional', 'none']);
const NOVELTY = Object.freeze(['novel', 'partial_duplicate', 'duplicate']);
const IMPACT_LEVELS = Object.freeze(['high', 'medium', 'low', 'none']);

// Пять каналов влияния (в терминах спеки критика). Модель материальности
// оперирует шестью измерениями — payment сводится в оплату (cost) и договор.
const IMPACT_KEYS = Object.freeze([
  'scope_impact',
  'cost_impact',
  'schedule_impact',
  'contract_impact',
  'responsibility_impact',
]);

const EVIDENCE_RANK = Object.freeze({ strong: 3, medium: 2, weak: 1, none: 0 });
const CONSEQUENCE_RANK = Object.freeze({ critical: 4, high: 3, medium: 2, low: 1, none: 0 });
const IMPACT_RANK = Object.freeze({ high: 3, medium: 2, low: 1, none: 0 });
const ACTIONABILITY_RANK = Object.freeze({ actionable: 2, conditional: 1, none: 0 });

const evidenceRank = (v) => EVIDENCE_RANK[v] || 0;
const consequenceRank = (v) => CONSEQUENCE_RANK[v] || 0;
const impactRank = (v) => IMPACT_RANK[v] || 0;
const actionabilityRank = (v) => ACTIONABILITY_RANK[v] || 0;

function pickEnum(value, allowed, fallback) {
  const s = String(value == null ? '' : value).trim().toLowerCase().replace(/[\s-]+/g, '_');
  return allowed.includes(s) ? s : fallback;
}

// Fail-closed нормализация ответа модели: неизвестное значение = самое
// осторожное (нет доказательств, нет последствия, нечего делать, это повтор).
const normalizeEvidence = (v) => pickEnum(v, EVIDENCE_STRENGTH, 'none');
const normalizeConsequence = (v) => pickEnum(v, BUSINESS_CONSEQUENCE, 'none');
const normalizeActionability = (v) => pickEnum(v, ACTIONABILITY, 'none');
const normalizeNovelty = (v) => pickEnum(v, NOVELTY, 'duplicate');
const normalizeImpact = (v) => pickEnum(v, IMPACT_LEVELS, 'none');

// --- Базовая карта из детерминированного вердикта ----------------------------

function levelFromWeight(w) {
  if (w >= 3) return 'high';
  if (w >= 2) return 'medium';
  if (w > 0) return 'low';
  return 'none';
}

// Веса шести измерений материальности → пять каналов критика.
// payment (приёмка/оплата) бьёт и по деньгам, и по договору — поэтому идёт в оба.
function impactsFromWeights(dimensionWeights = {}) {
  const dw = dimensionWeights || {};
  const w = {
    scope_impact: dw.scope || 0,
    cost_impact: (dw.price || 0) + (dw.payment || 0),
    schedule_impact: dw.schedule || 0,
    contract_impact: (dw.contract || 0) + (dw.payment || 0),
    responsibility_impact: dw.responsibility || 0,
  };
  const out = {};
  for (const key of IMPACT_KEYS) out[key] = levelFromWeight(w[key]);
  return out;
}

// Итоговое последствие для бизнеса. critical — когда бьёт сразу по нескольким
// каналам или суммарный вес критериев велик: одиночный признак критическим не
// бывает, сколько бы агент ни настаивал.
function consequenceFromImpacts(impacts, materialWeight = 0) {
  const levels = IMPACT_KEYS.map((k) => impacts[k]);
  const high = levels.filter((l) => l === 'high').length;
  if (high >= 2 || materialWeight >= 6) return 'critical';
  if (high >= 1) return 'high';
  if (levels.some((l) => l === 'medium')) return 'medium';
  if (levels.some((l) => l === 'low')) return 'low';
  return 'none';
}

// Типы проблем, у которых якоря в ТЗ НЕТ ПО ОПРЕДЕЛЕНИЮ: «условие отсутствует»
// указывает не на формулировку, а на ПРОБЕЛ. Доказательство такой находки —
// реестр существенных условий компании + детерминированная агрегация по всем
// частям ТЗ (тема не затронута нигде), а не цитата. Без обоснования (basis)
// льгота не действует — безосновательный пробел остаётся 'none' и отклоняется.
const CONDITION_GAP_TYPES = new Set(['условие_отсутствует']);

// Доказательность по СТРУКТУРЕ находки. none — когда указывать не на что:
// ни цитаты, ни абзаца, ни обоснования. Заявленное агентом значение может
// только понизить оценку (fail-closed) — поднять её агент не вправе.
// registryGap=true (тип из CONDITION_GAP_TYPES) — отсутствие цитаты штатно:
// с обоснованием такая находка получает 'medium' (реестр + полная сверка).
function evidenceFromStructure({
  anchored, hasQuote, hasPlace, hasBasis, corroboration = 1, declared = null, registryGap = false,
}) {
  let level;
  if (registryGap) level = hasBasis ? 'medium' : 'none';
  else if (!hasQuote && !hasPlace) level = 'none';
  else if (!anchored && !hasBasis) level = 'none';
  else if (!anchored || !hasBasis) level = 'weak';
  else level = Number(corroboration) >= 2 ? 'strong' : 'medium';

  if (declared) {
    const d = normalizeEvidence(declared);
    if (evidenceRank(d) < evidenceRank(level)) return d;
  }
  return level;
}

// Можно ли с замечанием что-то сделать. Замечание без выхода («просто примите к
// сведению») инженеру в основном списке не нужно, даже если формально верно.
function actionabilityOf(draft) {
  const action = canonicalAction(draft.suggested_action, ACTIONS.COMMENT);
  const hasRedaction = Boolean((draft.suggested_redaction || '').trim());
  const family = actionFamily(action);
  if (hasRedaction) return 'actionable';
  if (family === FAMILY.REMOVE || family === FAMILY.MODIFY) return 'actionable';
  if (action === ACTIONS.CLARIFY || action === ACTIONS.ASSUMPTION) return 'conditional';
  return 'none';
}

// Текст замечания одной строкой (для текстовых признаков).
function textOf(draft) {
  return [draft.basis, draft.review_comment, draft.source_fragment, draft.tz_clause]
    .filter(Boolean)
    .join(' \n ')
    .toLowerCase();
}

// --- Ключ повтора -----------------------------------------------------------
//
// Замечание-повтор — то же ТРЕБОВАНИЕ ТЗ, вынесенное второй раз (одна и та же
// формулировка в двух абзацах, одна и та же мысль от двух стадий, уцелевшая
// после сборки). Ключ строится по СМЫСЛУ, а не по id: цитата + тип проблемы +
// семейство действия + начало обоснования.

function norm(s) {
  return (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function meaningKey(draft) {
  const quote = norm(draft.source_fragment);
  const problem = norm(draft.problem_type);
  const family = actionFamily(draft.suggested_action);
  const basis = norm(draft.basis).slice(0, 80);
  return `${quote}::${problem}::${family}::${basis}`;
}

// Более слабый ключ: то же место + тот же канал влияния, но другой текст —
// «частичный повтор». Сам по себе не отклоняется (решает критик).
function placeKey(draft) {
  const clause = norm(draft.tz_clause);
  if (clause) return `clause:${clause}`;
  if (draft.paragraph_index != null) return `para:${draft.paragraph_index}`;
  const quote = norm(draft.source_fragment);
  return quote ? `frag:${quote}` : null;
}

// --- Сборка карты -----------------------------------------------------------

// draft   — строка draft_issues (или её форма из unifiedIssueBuilder);
// review  — вердикт материальности (criticService.evaluateDraft): даёт веса
//           сработавших критериев компании и число независимых сигналов;
// context — { novelty } кросс-набор (считает precision/index.js по всему набору).
function buildAssessment(draft, review = {}, context = {}) {
  const hasQuote = Boolean((draft.source_fragment || '').trim());
  const hasPlace = draft.paragraph_index != null || Boolean((draft.tz_clause || '').trim());
  const hasBasis = Boolean((draft.basis || '').trim());
  const anchored = draft.paragraph_index != null && hasQuote;
  const conditionGap = CONDITION_GAP_TYPES.has(draft.problem_type);

  const impacts = impactsFromWeights(review.dimension_weights);
  const materialWeight = typeof review.material_weight === 'number' ? review.material_weight : 0;
  const business_consequence = consequenceFromImpacts(impacts, materialWeight);

  const evidence_strength = evidenceFromStructure({
    anchored,
    hasQuote,
    hasPlace,
    hasBasis,
    corroboration: review.corroboration || 1,
    declared: review.declared_evidence || null,
    registryGap: conditionGap,
  });

  const text = textOf(draft);

  return {
    evidence_strength,
    business_consequence,
    actionability: actionabilityOf(draft),
    novelty: normalizeNovelty(context.novelty || 'novel'),
    ...impacts,
    // Служебные признаки для жёстких фильтров и промта критика (в БД уходят
    // вместе с картой — по ним видно, ПОЧЕМУ сработало правило).
    signals: {
      anchored,
      has_quote: hasQuote,
      has_place: hasPlace,
      has_basis: hasBasis,
      condition_gap: conditionGap,
      corroboration: review.corroboration || 1,
      material_weight: materialWeight,
      criteria: Array.isArray(review.criteria) ? review.criteria : [],
      editorial: EDITORIAL_RE.test(text),
      standard_requirement: STANDARD_REQUIREMENT_RE.test(text),
      assumption_language: ASSUMPTION_RE.test(text),
      informational_language: INFORMATIONAL_RE.test(text),
      declared_flags: Array.isArray(review.declared_flags) ? review.declared_flags : [],
    },
  };
}

// Нормализация карты, пришедшей от LLM: значения — только из словарей.
function normalizeAssessment(raw = {}) {
  const out = {
    evidence_strength: normalizeEvidence(raw.evidence_strength),
    business_consequence: normalizeConsequence(raw.business_consequence),
    actionability: normalizeActionability(raw.actionability),
    novelty: normalizeNovelty(raw.novelty),
  };
  for (const key of IMPACT_KEYS) out[key] = normalizeImpact(raw[key]);
  return out;
}

module.exports = {
  // словари
  EVIDENCE_STRENGTH,
  BUSINESS_CONSEQUENCE,
  ACTIONABILITY,
  NOVELTY,
  IMPACT_LEVELS,
  IMPACT_KEYS,
  CONDITION_GAP_TYPES,
  // ранги/сравнение
  evidenceRank,
  consequenceRank,
  impactRank,
  actionabilityRank,
  // нормализация
  normalizeEvidence,
  normalizeConsequence,
  normalizeActionability,
  normalizeNovelty,
  normalizeImpact,
  normalizeAssessment,
  // расчёт
  levelFromWeight,
  impactsFromWeights,
  consequenceFromImpacts,
  evidenceFromStructure,
  actionabilityOf,
  textOf,
  meaningKey,
  placeKey,
  buildAssessment,
};
