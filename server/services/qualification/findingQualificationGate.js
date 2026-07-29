'use strict';

// КВАЛИФИКАЦИОННЫЙ ФИЛЬТР КАЧЕСТВА ЗАМЕЧАНИЙ ИИ (shadow mode).
//
// Независимый чистый слой: получает находки агента КАК ДАННЫЕ (формат
// benchmark/runs/*.findings.json либо аналогичный) и для каждой возвращает
// квалификацию publish | review | hide | reject. НИЧЕГО не пишет: ни в БД,
// ни в production-таблицы, ни во входные объекты (shadow mode). Production-путь
// публикации (materiality + precision-критик) не трогается — фильтр
// оценивается ТОЛЬКО через benchmark-контур.
//
// Решение принимают ИМЕНОВАННЫЕ HARD GATES (порядок значим, сработавшее правило
// останавливает разбор), а НЕ один непрозрачный балл. Балл (confidence +
// score_breakdown) считается ОТДЕЛЬНО и только для диагностики.
//
// Обязательные элементы замечания (missing_requirements):
//   exact_quote / quote_anchor / quote_confirms_conclusion — evidence;
//   concrete_source — основание (ВОР+ТЗ, чек-лист, Q&A, договорное условие,
//     решение, противоречие или открытая формулировка самого ТЗ);
//   impact_type — последствие для ГП (cost/schedule/scope/payment/liability/
//     acceptance/warranty/technical_feasibility);
//   concrete_action — действие (exclude/limit_scope/replace/clarify/
//     request_from_customer/assumption/commercial_reservation).
//
// Особое правило (rescue): критическое замечание с сильной цитатой, доказанным
// влиянием и конкретным действием НЕ может быть скрыто из-за низкой общей
// уверенности — минимум review. Заявленный агентом confidence в решении не
// участвует вовсе.

const { prepareDocument, locateQuote } = require('../benchmark/matcher');
const {
  normalizeRu,
  stemSet,
  detectWorkObject,
  riskTypeOf,
} = require('../clustering/topicModel');
const { normalizeImpactLevel, impactRank } = require('../review/materiality');
const signals = require('./qualificationSignals');

// --- Оценка одной находки (факты, без решения) -------------------------------

function assessFinding(raw, index, doc) {
  const quote = String(raw.quote || raw.source_fragment || '').trim();
  const summary = String(raw.summary || raw.title || raw.text || '').trim();
  const basis = String(raw.basis || '').trim();
  const problemType = String(raw.problem_type || '').trim();
  const located = quote ? locateQuote(doc, quote) : null;
  const qNorm = normalizeRu(quote);
  const anchoredExact = !!qNorm && (
    (located && located.exact) || doc.fullNorm.includes(qNorm)
  );
  const anchored = anchoredExact || located != null;
  const sources = signals.detectSources({ basis, quote, problemType });
  const flags = signals.detectFlags({ quote, summary, basis, problemType });
  const text = [summary, basis].filter(Boolean).join(' ') || quote;
  return {
    index,
    id: String(raw.id || `finding-${index + 1}`),
    rank: Number.isFinite(Number(raw.rank)) ? Number(raw.rank) : index + 1,
    quote,
    summary,
    basis,
    problemType,
    has_quote: !!quote,
    anchored,
    anchored_exact: anchoredExact,
    paragraph: located ? located.index : null,
    quote_confirms: anchored && signals.quoteSupportsConclusion({ quote, summary, basis }),
    sources,
    source_strength: signals.sourceStrength(sources),
    impact_types: signals.detectImpactTypes({
      dimensions: raw.impact_dimensions,
      texts: [summary, basis],
    }),
    gate_action: signals.normalizeGateAction(raw.required_action),
    declared_impact: raw.impact_level == null || raw.impact_level === ''
      ? null
      : normalizeImpactLevel(raw.impact_level),
    flags,
    quoteStems: stemSet(quote),
    textStems: stemSet(text),
    workObject: detectWorkObject(text || quote),
    riskFamily: riskTypeOf({ problem_type: problemType, category: raw.risk_category || raw.category }),
    duplicate_of: null, // проставляет qualifyFindings
  };
}

// Доказательность — ТОЛЬКО по структуре находки (никакого confidence модели):
// нет цитаты в документе → none; цитата не подтверждает вывод либо нет
// основания → weak; якорь + подтверждение + конкретный источник → medium;
// дословный якорь + сильный источник (противоречие, ТЗ+ВОР) или два
// независимых источника → strong.
function evidenceStrengthOf(a) {
  if (!a.has_quote || !a.anchored) return 'none';
  if (!a.quote_confirms) return 'weak';
  if (!a.source_strength) return 'weak';
  const distinct = new Set(a.sources.map((s) => s.type)).size;
  if (a.anchored_exact && (a.source_strength >= 0.85 || distinct >= 2)) return 'strong';
  return 'medium';
}

// Кандидат приоритета: заявленный агентом уровень влияния, а при его отсутствии
// — вывод из структуры (сильный источник / открытая формулировка → high).
function priorityCandidate(a, evidence) {
  const declared = a.declared_impact;
  if (declared && declared !== 'none') return declared;
  if (!a.impact_types.length) return 'informational';
  if (evidence !== 'none' && (a.source_strength >= 0.85 || a.flags.open_wording)) return 'high';
  return declared === 'none' ? 'informational' : 'medium';
}

// --- HARD GATES --------------------------------------------------------------
//
// Каждое правило: key, qualification (или null → считается функцией outcomeFor),
// reason (ru), test(a, ctx). Порядок значим: сначала reject (нечего показывать),
// затем hide (валидно, но шум), затем review, затем publish.

const PUBLISH_MIN_SOURCE = 0.7;

const publishable = (a, e) =>
  (e === 'strong' || e === 'medium')
  && a.impact_types.length > 0
  && a.gate_action != null
  && (a.source_strength >= PUBLISH_MIN_SOURCE || new Set(a.sources.map((s) => s.type)).size >= 2);

const RULES = [
  // --- reject: замечание невалидно ------------------------------------------
  {
    key: 'no_quote',
    qualification: 'reject',
    reason: 'Нет точной цитаты: не на что указать в документе.',
    test: (a) => !a.has_quote,
  },
  {
    key: 'quote_not_in_document',
    qualification: 'reject',
    reason: 'Цитата не найдена в документе — вывод не подтверждён текстом.',
    test: (a) => !a.anchored,
  },
  {
    key: 'quote_not_confirming',
    qualification: 'reject',
    reason: 'Цитата не подтверждает вывод: формулировка замечания о другом.',
    test: (a) => !a.quote_confirms,
  },
  {
    key: 'duplicate',
    qualification: 'reject',
    reason: 'Явный дубль: то же место и тот же риск уже вынесены другим замечанием.',
    test: (a) => a.duplicate_of != null,
  },
  {
    key: 'unconfirmed_assumption',
    qualification: 'reject',
    reason: 'Неподтверждённое предположение: вывод-догадка без конкретного источника.',
    test: (a, e) => a.flags.assumption_language && a.source_strength < 0.6 && e !== 'strong',
  },
  {
    key: 'no_basis_source',
    qualification: 'reject',
    reason: 'Нет основания: ни обоснования, ни источника (ВОР / чек-лист / Q&A / договорное условие / противоречие ТЗ).',
    test: (a) => !a.basis && a.source_strength === 0,
  },

  // --- hide: валидно, но инженеру в списке не нужно -------------------------
  {
    key: 'editorial',
    qualification: 'hide',
    reason: 'Редактура: оформление текста, коммерческие и договорные условия не меняются.',
    test: (a, e, prio) => a.flags.editorial && impactRank(prio) <= impactRank('medium'),
  },
  {
    key: 'standard_requirement',
    qualification: 'hide',
    reason: 'Стандартное нормативное требование без дополнительного риска — ГП исполняет его и так.',
    test: (a) => a.flags.standard_requirement
      && !a.flags.open_wording
      && !a.sources.some((s) => s.type === 'tz_contradiction' || s.strength >= 0.85),
  },
  {
    key: 'no_impact',
    qualification: 'hide',
    reason: 'Нет последствия для ГП: не названо ни одного типа влияния.',
    test: (a) => a.impact_types.length === 0,
  },
  {
    key: 'low_significance',
    qualification: 'hide',
    reason: 'Малозначимое замечание: влияние низкое, публикация — шум.',
    test: (a, e, prio) => prio === 'low' || prio === 'informational',
  },

  // --- review: потенциально существенно, решает инженер ---------------------
  {
    key: 'aggregated_vor',
    qualification: 'review',
    reason: 'ВОР может содержать укрупнённую позицию: прямого доказательства пропуска нет, состав цены надо уточнить.',
    test: (a) => a.flags.aggregated_vor && a.sources.some((s) => s.type === 'vor'),
  },
  {
    key: 'ambiguous_wording',
    qualification: 'review',
    reason: 'Формулировка допускает несколько разумных толкований — требуется решение инженера.',
    test: (a) => a.flags.ambiguity && !a.flags.open_wording,
  },
  {
    key: 'no_concrete_action',
    qualification: 'review',
    reason: 'Не названо конкретное действие — публиковать нельзя, риск отдаётся инженеру.',
    test: (a) => a.gate_action == null,
  },
  {
    key: 'insufficient_source',
    qualification: 'review',
    reason: 'Недостаточно подтверждающих источников: одного слабого основания для публикации мало.',
    test: (a, e) => !publishable(a, e),
  },

  // --- publish ---------------------------------------------------------------
  {
    key: 'qualified_publish',
    qualification: 'publish',
    reason: 'Доказательства не ниже medium, названо последствие и конкретное действие — материальное замечание по предмету тендера.',
    test: (a, e) => publishable(a, e),
  },
];

// Правила, при которых rescue НЕ применяется: это структурные отказы
// (нет якоря / дубль / нет источника), а не «низкая уверенность».
const RESCUE_BLOCKED = new Set([
  'no_quote',
  'quote_not_in_document',
  'quote_not_confirming',
  'duplicate',
  'no_basis_source',
  'unconfirmed_assumption',
]);

// --- Диагностический score (НЕ основание решения) ---------------------------

const EVIDENCE_SCORE = { strong: 0.35, medium: 0.25, weak: 0.1, none: 0 };
const PRIORITY_SCORE = {
  critical: 0.1, high: 0.08, medium: 0.05, low: 0.02, informational: 0,
};
const round2 = (n) => Number(n.toFixed(2));

function scoreBreakdown(a, evidence, priority) {
  const flagPenalty = ['editorial', 'standard_requirement', 'assumption_language']
    .filter((f) => a.flags[f]).length * 0.1 + (a.duplicate_of ? 0.2 : 0);
  const parts = {
    evidence: EVIDENCE_SCORE[evidence] || 0,
    source: round2(a.source_strength * 0.25),
    impact: round2(Math.min(a.impact_types.length, 2) * 0.1),
    action: a.gate_action ? 0.1 : 0,
    materiality: PRIORITY_SCORE[priority] || 0,
    penalties: round2(-flagPenalty),
  };
  const total = round2(Math.max(0, Math.min(1,
    parts.evidence + parts.source + parts.impact + parts.action + parts.materiality + parts.penalties,
  )));
  return { parts, total };
}

// --- Решение по одной находке ------------------------------------------------

function missingRequirementsOf(a) {
  const missing = [];
  if (!a.has_quote) missing.push('exact_quote');
  if (a.has_quote && !a.anchored) missing.push('quote_anchor');
  if (a.anchored && !a.quote_confirms) missing.push('quote_confirms_conclusion');
  if (a.source_strength < 0.6) missing.push('concrete_source');
  if (!a.impact_types.length) missing.push('impact_type');
  if (!a.gate_action) missing.push('concrete_action');
  return missing;
}

function decide(a) {
  const evidence = evidenceStrengthOf(a);
  const prio = priorityCandidate(a, evidence);
  let fired = null;
  for (const rule of RULES) {
    if (rule.test(a, evidence, prio)) { fired = rule; break; }
  }
  // Терминальное правило qualified_publish покрывает все годные находки;
  // сюда попадать не должно, но fail-closed исход — review, не потеряно.
  if (!fired) fired = { key: 'unresolved', qualification: 'review', reason: 'Однозначного правила не нашлось — на проверку инженеру.' };

  let qualification = fired.qualification;
  const reasons = [fired.reason];

  // Особое правило: критический/высокий риск с сильной цитатой, доказанным
  // влиянием и конкретным действием не может уйти в hide/reject «по
  // неуверенности» — минимум review (publish, если проходит все требования A).
  let rescued = false;
  if ((qualification === 'hide' || qualification === 'reject')
    && !RESCUE_BLOCKED.has(fired.key)
    && impactRank(prio) >= impactRank('high')
    && a.anchored_exact
    && a.impact_types.length > 0
    && a.gate_action != null
    && (evidence === 'strong' || evidence === 'medium')) {
    qualification = publishable(a, evidence) ? 'publish' : 'review';
    rescued = true;
    reasons.push('Особое правило: сильная цитата + доказанное влияние + конкретное действие — замечание не скрывается.');
  }

  // Скрытое: редактура/стандартное/без последствия — informational; чисто
  // малозначимое — low. Видимое — кандидат приоритета (не ниже medium).
  const priority = (qualification === 'hide' || qualification === 'reject')
    ? (fired.key === 'low_significance' && prio === 'low' ? 'low' : 'informational')
    : (prio === 'none' || prio === 'informational' ? 'medium' : prio);
  const score = scoreBreakdown(a, evidence, priority);
  if (a.duplicate_of) reasons.push(`Дубль замечания «${a.duplicate_of}».`);

  return {
    finding_id: a.id,
    qualification,
    priority,
    confidence: score.total,
    evidence_strength: evidence,
    impact_types: a.impact_types,
    source_strength: a.source_strength,
    missing_requirements: missingRequirementsOf(a),
    reasons,
    score_breakdown: { ...score.parts, total: score.total },
    rule: fired.key,
    rescued,
    sources: a.sources,
    flags: a.flags,
    duplicate_of: a.duplicate_of,
  };
}

// --- Публичный API -----------------------------------------------------------

// qualifyFindings(findings, { sourceText }) → массив решений в порядке входа.
// SHADOW MODE: входные объекты не мутируются, никакой записи наружу.
function qualifyFindings(findings = [], { sourceText = '' } = {}) {
  const doc = prepareDocument(sourceText);
  const assessments = findings.map((f, i) => assessFinding(f || {}, i, doc));
  // Дубли: первое по rank остаётся, последующие о том же месте/риске помечаются.
  const ordered = [...assessments].sort((x, y) => x.rank - y.rank || x.index - y.index);
  const kept = [];
  for (const a of ordered) {
    const dup = kept.find((k) => signals.isDuplicatePair(k, a));
    if (dup) a.duplicate_of = dup.id;
    else if (a.anchored) kept.push(a);
  }
  return assessments.map((a) => decide(a));
}

// Одна находка (без междунаходочной проверки дублей).
function qualifyFinding(finding, { sourceText = '' } = {}) {
  return qualifyFindings([finding], { sourceText })[0];
}

module.exports = {
  RULES,
  RESCUE_BLOCKED,
  PUBLISH_MIN_SOURCE,
  assessFinding,
  evidenceStrengthOf,
  qualifyFinding,
  qualifyFindings,
};
