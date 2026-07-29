'use strict';

// СИГНАЛЫ квалификационного фильтра качества замечаний (shadow mode).
//
// Чистый модуль: словари gate + детерминированная детекция структурных
// признаков находки (источник основания, типы влияния, действие, флаги
// нематериальности, подтверждение вывода цитатой). Без БД, сети и LLM.
// Решения здесь НЕ принимаются — только факты; правила квалификации живут в
// findingQualificationGate.js.

const {
  normalizeRu,
  stemSet,
  similarity,
  detectWorkObject,
  riskTypeOf,
} = require('../clustering/topicModel');
const { normalizeRequiredAction } = require('../review/materiality');

// --- Словари gate ------------------------------------------------------------

const QUALIFICATIONS = Object.freeze(['publish', 'review', 'hide', 'reject']);
const PRIORITIES = Object.freeze(['critical', 'high', 'medium', 'low', 'informational']);
const EVIDENCE_STRENGTHS = Object.freeze(['strong', 'medium', 'weak', 'none']);

// Типы влияния на ГП — расширенный словарь gate (шире materiality-измерений).
const IMPACT_TYPES = Object.freeze([
  'cost',
  'schedule',
  'scope',
  'payment',
  'liability',
  'acceptance',
  'warranty',
  'technical_feasibility',
]);

// Конкретные действия gate.
const GATE_ACTIONS = Object.freeze([
  'exclude',
  'limit_scope',
  'replace',
  'clarify',
  'request_from_customer',
  'assumption',
  'commercial_reservation',
]);

// Типы источника основания.
const SOURCE_TYPES = Object.freeze([
  'tz_contradiction', // прямое противоречие внутри ТЗ / несоответствие пунктов
  'tz_wording', // риск доказан самой формулировкой ТЗ (открытая обязанность и т.п.)
  'vor', // сверка с ведомостью объёмов работ
  'checklist', // чек-лист компании
  'qa', // Q&A / разъяснения заказчика
  'contract_condition', // договорное / существенное условие компании
  'decision', // принятое решение (инженера / тендерного комитета)
]);

// Обязательные элементы замечания (missing_requirements).
const REQUIREMENTS = Object.freeze([
  'exact_quote',
  'quote_anchor',
  'quote_confirms_conclusion',
  'concrete_source',
  'impact_type',
  'concrete_action',
]);

// --- Типы влияния ------------------------------------------------------------

// materiality-измерение → тип влияния gate.
const DIMENSION_TO_IMPACT = Object.freeze({
  price: 'cost',
  schedule: 'schedule',
  payment: 'payment',
  contract: 'liability',
  responsibility: 'liability',
  scope: 'scope',
});

// Детекция по тексту (summary + basis, нормализованный вид).
// ВАЖНО: \b в JS не работает с кириллицей (\w — только ASCII), поэтому границы
// слов заданы явно через (^| ) и ( |$) по нормализованному тексту.
const IMPACT_TYPE_PATTERNS = [
  ['cost', /стоимост|удорожан|затрат|смет[аеныу]|цен[аыуе]( |$)|кассов|деньг|расход|рассчитать нельзя|не поддается расчет|не попадет в расчет|расчет стоимост/],
  ['schedule', /срок|график|календарн|просрочк/],
  ['scope', /объем[а-я]* работ|расширен[а-я]* объем|состав[а-я]* работ|сверх расчет|объем не ограничен|без ограничени[а-я]* объем/],
  ['payment', /оплат|платеж|аванс|удержани|кс 2|кс 3|кассов[а-я]* разрыв/],
  ['liability', /ответственност|штраф|неустойк|возмещен|обязанност|за свой счет|за счет подрядчик/],
  ['acceptance', /приемк|ввод[а-я]* (объекта )?в эксплуатац|акт[а-я]* сдач|освидетельствован/],
  ['warranty', /гаранти/],
  ['technical_feasibility', /невыполним|неосуществим|технически невозможн|конструктивно невозможн/],
];

// Заявленные измерения + свободный текст → канонический набор типов влияния.
function detectImpactTypes({ dimensions = [], texts = [] } = {}) {
  const found = new Set();
  const raw = Array.isArray(dimensions) ? dimensions : [dimensions];
  for (const item of raw) {
    const s = String(item == null ? '' : item).trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (!s) continue;
    if (IMPACT_TYPES.includes(s)) { found.add(s); continue; }
    if (DIMENSION_TO_IMPACT[s]) found.add(DIMENSION_TO_IMPACT[s]);
  }
  const text = normalizeRu(texts.filter(Boolean).join(' '));
  if (text) {
    for (const [type, re] of IMPACT_TYPE_PATTERNS) {
      if (re.test(text)) found.add(type);
    }
  }
  return IMPACT_TYPES.filter((t) => found.has(t));
}

// --- Действие ----------------------------------------------------------------

const MATERIALITY_TO_GATE_ACTION = Object.freeze({
  exclude_scope: 'exclude',
  amend_tz: 'replace',
  ask_customer: 'request_from_customer',
  add_assumption: 'assumption',
  recalculate: 'commercial_reservation', // пересчёт = учесть в КП/оговорке расчёта
});

const GATE_ACTION_PATTERNS = [
  ['limit_scope', /ограничи[а-я]* объем|лимит[а-я]* объем/],
  ['exclude', /исключ|вынес/],
  ['replace', /замен|изменить формулировк|переформул|скорректировать текст/],
  ['request_from_customer', /запрос[а-я]* (у )?заказчик|вопрос[а-я]* заказчик/],
  ['clarify', /уточн|поясн/],
  ['assumption', /допущени/],
  ['commercial_reservation', /оговорк|резерв|пересчит|учесть в кп/],
];

// Значение действия (словарь gate, словарь materiality или свободный текст)
// → каноническое действие gate; null = конкретного действия нет.
function normalizeGateAction(value) {
  const s = String(value == null ? '' : value).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!s || s === 'none') return null;
  if (GATE_ACTIONS.includes(s)) return s;
  const viaMateriality = normalizeRequiredAction(s, 'none');
  if (viaMateriality !== 'none') return MATERIALITY_TO_GATE_ACTION[viaMateriality] || null;
  const norm = normalizeRu(value);
  for (const [action, re] of GATE_ACTION_PATTERNS) {
    if (re.test(norm)) return action;
  }
  return null;
}

// --- Источник основания ------------------------------------------------------

// Открытая формулировка ТЗ — риск доказывается самим текстом пункта.
const OPEN_WORDING_RE = /за свой счет|за счет подрядчик|в объеме необходим|по требованию|без ограничени|неограничен|силами подрядчик|определя[ею]т(ся)? (заказчик|подрядчик|эксплуатирующ)|в полном объеме|до полного удовлетворен/;

// Ссылка на требование ТЗ в основании (пункт / раздел / «ТЗ требует»).
const TZ_REF_RE = /(^| )тз( |$)|пункт|(^| )п \d|раздел|требует|состав работ/;

const SOURCE_DEFS = [
  { type: 'tz_contradiction', strength: 1.0, re: /противореч|не соответству|расходится|взаимоисключ/ },
  { type: 'contract_condition', strength: 0.8, re: /договорн|контракт|существенн[а-я]* услови|типов[а-я]* услови|услови[а-я]* компани/ },
  { type: 'checklist', strength: 0.7, re: /чек лист|чеклист/ },
  { type: 'qa', strength: 0.7, re: /q&a|вопрос[а-я]* и ответ|разъяснени[а-я]* заказчик/ },
  { type: 'decision', strength: 0.7, re: /принят[а-я]* решени|решени[а-я]* (инженер|тендерн)/ },
  { type: 'vor', strength: 0.6, re: /(^| )вор( |$)|ведомост|приложени/ },
];

// Основание + цитата + тип проблемы → список источников с силой каждого.
// ВАЖНО: отсутствие позиции в ВОР САМО ПО СЕБЕ — не сильное доказательство
// (0.6): сильным (0.85) оно становится, только когда основание одновременно
// ссылается на требование ТЗ («п. N требует X, в ведомости X нет»).
function detectSources({ basis = '', quote = '', problemType = '' } = {}) {
  const basisNorm = normalizeRu([basis, problemType].filter(Boolean).join(' '));
  const quoteNorm = normalizeRu(quote);
  const sources = [];
  for (const def of SOURCE_DEFS) {
    if (!basisNorm || !def.re.test(basisNorm)) continue;
    if (def.type === 'vor' && TZ_REF_RE.test(basisNorm)) {
      sources.push({ type: 'vor', strength: 0.85, note: 'требование ТЗ + отсутствие в ВОР' });
    } else {
      sources.push({ type: def.type, strength: def.strength });
    }
  }
  if (OPEN_WORDING_RE.test(quoteNorm) || OPEN_WORDING_RE.test(basisNorm)) {
    sources.push({ type: 'tz_wording', strength: 0.75 });
  }
  return sources;
}

const round2 = (n) => Number(n.toFixed(2));

// Итоговая сила основания 0..1: максимум по источникам + бонус за второй
// независимый источник.
function sourceStrength(sources) {
  if (!sources.length) return 0;
  const max = Math.max(...sources.map((s) => s.strength));
  const distinct = new Set(sources.map((s) => s.type)).size;
  return round2(Math.min(1, max + (distinct > 1 ? 0.1 : 0)));
}

// --- Флаги нематериальности и режимов ----------------------------------------

const EDITORIAL_RE = /опечатк|орфограф|стилист|пунктуац|оформлени|нумерац|редакцион|редактур/;
const STANDARD_RE = /(^| )сп \d|(^| )гост|снип|санпин|нормативн|действующ[а-я]* норм|обычн[а-я]* практик/;
const ASSUMPTION_RE = /возможно|вероятно|скорее всего|по видимому|предположительн|предполага|может быть|наверн|видимо/;
const AMBIGUITY_RE = /неоднозначн|допускает [а-я ]*толкован|разн[а-я]* толкован|разночтен|двусмыслен/;
const AGGREGATED_RE = /укрупн|комплекс работ|не расшифрован|без расшифровк/;

function detectFlags({ quote = '', summary = '', basis = '', problemType = '' } = {}) {
  const claim = normalizeRu([summary, basis, problemType].filter(Boolean).join(' '));
  const all = normalizeRu([quote, summary, basis, problemType].filter(Boolean).join(' '));
  return {
    editorial: EDITORIAL_RE.test(claim),
    standard_requirement: STANDARD_RE.test(all),
    assumption_language: ASSUMPTION_RE.test(claim),
    ambiguity: AMBIGUITY_RE.test(claim),
    aggregated_vor: AGGREGATED_RE.test(claim),
    open_wording: OPEN_WORDING_RE.test(normalizeRu(quote)) || OPEN_WORDING_RE.test(claim),
  };
}

// --- Подтверждение вывода цитатой -------------------------------------------

// Доля основ меньшего множества, покрытая большим (та же метрика, что в
// benchmark/matcher.containment — здесь локально, чтобы не тянуть matcher).
function containment(a, b) {
  if (!a || !b || !a.size || !b.size) return 0;
  let inter = 0;
  for (const s of a) if (b.has(s)) inter += 1;
  return inter / Math.min(a.size, b.size);
}

const CONFIRM_CONTAINMENT = 0.2;
const CONFIRM_SIMILARITY = 0.15;

// Детерминированная проверка «цитата действительно подтверждает вывод»:
// вывод (summary + basis) обязан пересекаться с цитатой лексически либо
// говорить о том же объекте работ (таксономия topicModel).
function quoteSupportsConclusion({ quote = '', summary = '', basis = '' } = {}) {
  const claim = [summary, basis].filter(Boolean).join(' ');
  if (!quote.trim() || !claim.trim()) return false;
  const q = stemSet(quote);
  const c = stemSet(claim);
  const wq = detectWorkObject(quote);
  const wc = detectWorkObject(claim);
  if (wq && wc && wq.id === wc.id) return true;
  return containment(c, q) >= CONFIRM_CONTAINMENT || similarity(c, q) >= CONFIRM_SIMILARITY;
}

// --- Дубли -------------------------------------------------------------------

const DUP_QUOTE_CONTAINMENT = 0.8;
const DUP_TEXT_SIMILARITY = 0.25;
const DUP_SAME_PLACE_SIMILARITY = 0.45;

// Два замечания об одном месте и одном риске = дубль. Первое (по rank)
// остаётся, последующие помечаются. Правило генерическое: место (цитата /
// абзац) + пересечение смысла, типов влияния или семейства риска.
function isDuplicatePair(kept, candidate) {
  if (!kept.anchored || !candidate.anchored) return false;
  const quoteOverlap = containment(kept.quoteStems, candidate.quoteStems);
  const textSim = similarity(kept.textStems, candidate.textStems);
  const impactOverlap = candidate.impact_types.some((t) => kept.impact_types.includes(t));
  const sameFamily = kept.riskFamily && kept.riskFamily === candidate.riskFamily;
  const sameObject = kept.workObject && candidate.workObject
    && kept.workObject.id === candidate.workObject.id;
  if (quoteOverlap >= DUP_QUOTE_CONTAINMENT
    && (impactOverlap || sameFamily || sameObject || textSim >= DUP_TEXT_SIMILARITY)) {
    return true;
  }
  return kept.paragraph != null && kept.paragraph === candidate.paragraph
    && textSim >= DUP_SAME_PLACE_SIMILARITY;
}

module.exports = {
  QUALIFICATIONS,
  PRIORITIES,
  EVIDENCE_STRENGTHS,
  IMPACT_TYPES,
  GATE_ACTIONS,
  SOURCE_TYPES,
  REQUIREMENTS,
  DIMENSION_TO_IMPACT,
  MATERIALITY_TO_GATE_ACTION,
  detectImpactTypes,
  normalizeGateAction,
  detectSources,
  sourceStrength,
  detectFlags,
  containment,
  quoteSupportsConclusion,
  isDuplicatePair,
  // для тестов и отчёта
  OPEN_WORDING_RE,
  riskTypeOf,
};
