'use strict';

// МОДЕЛЬ МАТЕРИАЛЬНОСТИ ЗАМЕЧАНИЯ — единый источник истины для решения
// «показывать ли замечание инженеру по умолчанию».
//
// Зачем отдельный слой. Раньше публикацию решали criticality (её ставил агент
// стадии) и confidence (уверенность модели в самой находке). Это разные вещи:
// «агент уверен, что в ТЗ написано именно так» ≠ «для ГП это стоит денег».
// Из-за подмены в основной поток попадала редактура и стандартные требования с
// confidence 0.95, а материальный договорной риск с осторожным confidence 0.5
// уходил вниз списка. Теперь публикацию решают ДВЕ независимые оси:
//
//   impact_level    — НАСКОЛЬКО дорого это ГП (цена/срок/оплата/договор/
//                     ответственность/объём). Считается по материальным
//                     критериям (critic), а НЕ по criticality агента.
//   evidence_level  — НАСКОЛЬКО подтверждено (дословная привязка к ТЗ,
//                     обоснование, независимые подтверждения). Считается по
//                     структурным фактам, а НЕ по confidence модели.
//
// Их пересечение даёт verdict (publish | verify | suppress) — см. VERDICT_MATRIX.
// criticality и confidence в этот расчёт НЕ ВХОДЯТ вовсе (правило 4): они
// остаются как легаси-поля сортировки/дебага.
//
// Файл ЧИСТЫЙ: без БД, без сети, без LLM — тестируется офлайн
// (server/test/unit/materiality.test.js).

const { ACTIONS, FAMILY, canonicalAction, actionFamily } = require('../analysis/actions');

// --- Словари ----------------------------------------------------------------

const IMPACT_LEVELS = Object.freeze(['critical', 'high', 'medium', 'low', 'none']);
const EVIDENCE_LEVELS = Object.freeze(['strong', 'medium', 'weak']);
const VERDICTS = Object.freeze(['publish', 'verify', 'suppress']);

// Измерения материальности — ровно те, что интересуют тендерный отдел.
const IMPACT_DIMENSIONS = Object.freeze([
  'price', // стоимость / расчёт / КП / смета
  'schedule', // срок / график / очередность
  'payment', // приёмка, оплата, КС-2/КС-3, удержания
  'contract', // договор / существенные условия
  'responsibility', // обязанности, ответственность, гарантия
  'scope', // объём работ ГП (расширение объёма)
]);

const REQUIRED_ACTIONS = Object.freeze([
  'amend_tz', // изменить формулировку ТЗ
  'exclude_scope', // вынести работу из объёма ГП
  'ask_customer', // задать вопрос заказчику (Q&A)
  'add_assumption', // зафиксировать допущение в КП
  'recalculate', // пересчитать объём/стоимость
  'none', // действий не требуется
]);

// Причины подавления (правило 3). Порядок = приоритет в тексте причины.
const SUPPRESSION_FLAGS = Object.freeze([
  'no_impact', // нет материального влияния
  'editorial', // редактура: орфография, оформление, нумерация
  'duplicate', // дубль другого замечания
  'standard_requirement', // стандартное требование (нормативы, обычная практика)
  'unconfirmed_assumption', // предположение, не подтверждённое текстом ТЗ
]);

const IMPACT_RANK = Object.freeze({ critical: 4, high: 3, medium: 2, low: 1, none: 0 });
const EVIDENCE_RANK = Object.freeze({ strong: 3, medium: 2, weak: 1 });
const VERDICT_RANK = Object.freeze({ publish: 3, verify: 2, suppress: 1 });

// Материальным считается влияние НЕ НИЖЕ этого уровня (правило 5: low не
// публикуется никогда, даже при strong evidence и высокой уверенности).
const MATERIAL_IMPACT_MIN = 'medium';

// --- Fail-closed нормализация ------------------------------------------------
//
// Fail-closed здесь = «не опубликовать по ошибке». Неизвестный уровень влияния
// → none (не публикуем), неизвестное доказательство → weak (не публикуем),
// неизвестный вердикт → verify (не публикуем, но и НЕ теряем: замечание уходит
// на проверку инженеру, а не в скрытые).

const IMPACT_FUZZY = [
  [/^(critical|критич|блокер|blocker)/, 'critical'],
  [/^(high|выс|существен|серьёз|серьез|важн)/, 'high'],
  [/^(medium|med|сред|умерен)/, 'medium'],
  [/^(low|низ|minor|незнач|мал)/, 'low'],
  [/^(none|нет|отсутств|no_impact|zero|нол)/, 'none'],
];

const EVIDENCE_FUZZY = [
  [/^(strong|сильн|надёжн|надежн|подтвержд|высок)/, 'strong'],
  [/^(medium|med|сред|частичн)/, 'medium'],
  [/^(weak|слаб|низк|предполож|косвен)/, 'weak'],
];

const VERDICT_FUZZY = [
  [/^(publish|опублик|показ|публик)/, 'publish'],
  [/^(verify|провер|уточн|под вопрос)/, 'verify'],
  [/^(suppress|скры|подав|отбро|не показ)/, 'suppress'],
];

function normKey(value) {
  return String(value == null ? '' : value).trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function normalizeEnum(value, allowed, fuzzy, fallback) {
  const s = normKey(value);
  if (!s) return fallback;
  if (allowed.includes(s)) return s;
  for (const [re, canon] of fuzzy) if (re.test(s)) return canon;
  return fallback;
}

function normalizeImpactLevel(value, fallback = 'none') {
  return normalizeEnum(value, IMPACT_LEVELS, IMPACT_FUZZY, fallback);
}

function normalizeEvidenceLevel(value, fallback = 'weak') {
  return normalizeEnum(value, EVIDENCE_LEVELS, EVIDENCE_FUZZY, fallback);
}

function normalizeVerdict(value, fallback = 'verify') {
  return normalizeEnum(value, VERDICTS, VERDICT_FUZZY, fallback);
}

function normalizeRequiredAction(value, fallback = 'none') {
  const s = normKey(value);
  if (REQUIRED_ACTIONS.includes(s)) return s;
  if (/^(amend|правк|измен|переформул|редакц)/.test(s)) return 'amend_tz';
  if (/^(exclude|вынес|исключ)/.test(s)) return 'exclude_scope';
  if (/^(ask|вопрос|запрос|уточн)/.test(s)) return 'ask_customer';
  if (/^(add_assum|допущ|assumption)/.test(s)) return 'add_assumption';
  if (/^(recalc|пересч|перерасч)/.test(s)) return 'recalculate';
  return fallback;
}

const DIMENSION_FUZZY = [
  [/(price|стоим|цен|смет|расч[её]т|kp|кп|удорожан)/, 'price'],
  [/(schedule|срок|график|календар|очередн|просрочк)/, 'schedule'],
  [/(payment|оплат|при[её]мк|кс-?2|кс-?3|плат[её]ж|удержан)/, 'payment'],
  [/(contract|договор|контракт|существенн)/, 'contract'],
  [/(responsib|ответствен|обязан|гаранти|штраф|неустойк)/, 'responsibility'],
  [/(scope|об[ъь][её]м|объем)/, 'scope'],
];

// Список измерений → канонический уникальный набор в порядке IMPACT_DIMENSIONS.
function normalizeDimensions(value) {
  const raw = Array.isArray(value)
    ? value
    : String(value == null ? '' : value).split(/[,;|]/);
  const found = new Set();
  for (const item of raw) {
    const s = normKey(item);
    if (!s) continue;
    if (IMPACT_DIMENSIONS.includes(s)) { found.add(s); continue; }
    for (const [re, canon] of DIMENSION_FUZZY) {
      if (re.test(s)) { found.add(canon); break; }
    }
  }
  return IMPACT_DIMENSIONS.filter((d) => found.has(d));
}

// Флаги подавления, заявленные агентом/выведенные детерминированно.
function normalizeSuppressionFlags(value) {
  const raw = Array.isArray(value) ? value : [value];
  const found = new Set();
  for (const item of raw) {
    const s = normKey(item);
    if (!s || s === 'material' || s === 'none') continue;
    if (SUPPRESSION_FLAGS.includes(s)) { found.add(s); continue; }
    if (/(редактур|орфограф|опечат|оформлен|editorial|стил)/.test(s)) found.add('editorial');
    else if (/(дубл|повтор|duplicate)/.test(s)) found.add('duplicate');
    else if (/(стандартн|типов|норматив|обычн|standard)/.test(s)) found.add('standard_requirement');
    else if (/(предполож|догадк|assumption|не подтвержд)/.test(s)) found.add('unconfirmed_assumption');
    else if (/(нет влияни|no_impact|не влия|безразлич)/.test(s)) found.add('no_impact');
  }
  return SUPPRESSION_FLAGS.filter((f) => found.has(f));
}

// --- Сравнение/агрегация уровней --------------------------------------------

const impactRank = (v) => IMPACT_RANK[normalizeImpactLevel(v)] || 0;
const evidenceRank = (v) => EVIDENCE_RANK[normalizeEvidenceLevel(v)] || 0;
const verdictRank = (v) => VERDICT_RANK[normalizeVerdict(v)] || 0;

function strongerImpact(a, b) {
  return impactRank(a) >= impactRank(b) ? normalizeImpactLevel(a) : normalizeImpactLevel(b);
}
function weakerEvidence(a, b) {
  return evidenceRank(a) <= evidenceRank(b) ? normalizeEvidenceLevel(a) : normalizeEvidenceLevel(b);
}
function strongerEvidence(a, b) {
  return evidenceRank(a) >= evidenceRank(b) ? normalizeEvidenceLevel(a) : normalizeEvidenceLevel(b);
}
function maxImpact(list) {
  return (list || []).reduce((acc, v) => strongerImpact(acc, v), 'none');
}
function maxEvidence(list) {
  return (list || []).reduce((acc, v) => strongerEvidence(acc, v), 'weak');
}
// Сильнейший вердикт набора: publish > verify > suppress (кластер значим, если
// значим хотя бы один его элемент).
function strongestVerdict(list) {
  return (list || []).reduce(
    (acc, v) => (verdictRank(v) > verdictRank(acc) ? normalizeVerdict(v) : acc),
    'suppress',
  );
}
function mergeDimensions(...lists) {
  return normalizeDimensions(lists.flatMap((l) => normalizeDimensions(l)));
}

const isMaterialImpact = (level) => impactRank(level) >= impactRank(MATERIAL_IMPACT_MIN);

// --- МАТРИЦА impact × evidence ----------------------------------------------
//
//              strong     medium     weak
//   critical   publish    publish    verify
//   high       publish    publish    verify
//   medium     publish    verify     verify
//   low        suppress   suppress   suppress
//   none       suppress   suppress   suppress
//
// Правила ТЗ: (1) publish — существенный риск + достаточные доказательства;
// (2) verify — риск может быть существенным, доказательств мало; (3) suppress —
// редактура/дубль/стандартное требование/нет влияния/неподтверждённое
// предположение; (5) low не публикуется даже при strong evidence; (6) high со
// weak evidence уходит в verify.
const VERDICT_MATRIX = Object.freeze({
  critical: Object.freeze({ strong: 'publish', medium: 'publish', weak: 'verify' }),
  high: Object.freeze({ strong: 'publish', medium: 'publish', weak: 'verify' }),
  medium: Object.freeze({ strong: 'publish', medium: 'verify', weak: 'verify' }),
  low: Object.freeze({ strong: 'suppress', medium: 'suppress', weak: 'suppress' }),
  none: Object.freeze({ strong: 'suppress', medium: 'suppress', weak: 'suppress' }),
});

// --- Человекочитаемые причины -----------------------------------------------

const IMPACT_RU = Object.freeze({
  critical: 'критическое',
  high: 'высокое',
  medium: 'умеренное',
  low: 'низкое',
  none: 'отсутствует',
});

const EVIDENCE_RU = Object.freeze({
  strong: 'подтверждено надёжно',
  medium: 'подтверждено частично',
  weak: 'подтверждено слабо',
});

const DIMENSION_RU = Object.freeze({
  price: 'стоимость',
  schedule: 'срок',
  payment: 'приёмка и оплата',
  contract: 'договорные условия',
  responsibility: 'обязанности и ответственность ГП',
  scope: 'объём работ ГП',
});

const SUPPRESSION_RU = Object.freeze({
  no_impact: 'нет материального влияния на цену, срок, оплату, договор, ответственность и объём работ ГП',
  editorial: 'редактура: замечание не меняет коммерческих и договорных условий',
  duplicate: 'дубль: то же место ТЗ уже вынесено другим замечанием',
  standard_requirement: 'стандартное требование (нормативы / обычная практика) — ГП его и так исполняет',
  unconfirmed_assumption: 'предположение не подтверждается текстом ТЗ',
});

const REQUIRED_ACTION_RU = Object.freeze({
  amend_tz: 'изменить формулировку ТЗ',
  exclude_scope: 'вынести из объёма ГП',
  ask_customer: 'запросить у заказчика',
  add_assumption: 'зафиксировать допущение в КП',
  recalculate: 'пересчитать объём/стоимость',
  none: 'действий не требуется',
});

// Префикс причин, проставленных миграцией старых данных: по нему видно, что
// уровень перенесён из прежней модели (display_priority), а не рассчитан.
const LEGACY_REASON_PREFIX = 'Перенесено из прежней модели оценки';

function dimensionsRu(dimensions) {
  const list = normalizeDimensions(dimensions).map((d) => DIMENSION_RU[d]);
  return list.length ? list.join(', ') : 'без явного измерения';
}

// --- Основное решение --------------------------------------------------------

// Считает вердикт по матрице impact × evidence.
//   impactLevel      — уровень влияния (critical|high|medium|low|none)
//   evidenceLevel    — уровень доказательности (strong|medium|weak)
//   dimensions       — измерения влияния (для текста причины)
//   suppressionFlags — жёсткие причины подавления (правило 3): перебивают матрицу
//   contested        — СПОРНОЕ замечание: агент объявил его нематериальным, а
//                      материальные критерии компании говорят обратное. Тогда
//                      флаги подавления НЕ применяются (не теряем деньги на
//                      мнении модели), но и publish понижается до verify —
//                      решает инженер.
//   note             — доп. фраза в причину (например, какие критерии сработали)
// Возвращает готовый набор полей для draft_issue / issue_review.
function resolveVerdict({
  impactLevel,
  evidenceLevel,
  dimensions = [],
  suppressionFlags = [],
  contested = false,
  note = null,
} = {}) {
  const impact = normalizeImpactLevel(impactLevel);
  const evidence = normalizeEvidenceLevel(evidenceLevel);
  const dims = normalizeDimensions(dimensions);
  const flags = contested ? [] : normalizeSuppressionFlags(suppressionFlags);
  const tail = note ? ` ${note}` : '';

  if (contested) {
    const matrixVerdict = normalizeVerdict((VERDICT_MATRIX[impact] || {})[evidence], 'verify');
    if (matrixVerdict === 'publish') {
      const reason =
        `Требует проверки: агент пометил замечание нематериальным ` +
        `(${normalizeSuppressionFlags(suppressionFlags).map((f) => SUPPRESSION_RU[f]).join('; ') || 'без причины'}), ` +
        `но критерии компании дают влияние ${IMPACT_RU[impact]} (${dimensionsRu(dims)}).${tail}`;
      return {
        impact_level: impact,
        evidence_level: evidence,
        impact_dimensions: dims,
        verdict: 'verify',
        publication_reason: null,
        suppression_reason: null,
        verdict_reason: reason,
        suppression_flags: [],
      };
    }
  }

  // Жёсткое подавление (правило 3) перебивает матрицу: редактура остаётся
  // редактурой, даже если рядом сработал материальный критерий.
  if (flags.length) {
    const reason = SUPPRESSION_RU[flags[0]];
    return {
      impact_level: impact,
      evidence_level: evidence,
      impact_dimensions: dims,
      verdict: 'suppress',
      publication_reason: null,
      suppression_reason: `${reason}.${tail}`,
      verdict_reason: `Скрыто: ${reason}.${tail}`,
      suppression_flags: flags,
    };
  }

  const verdict = normalizeVerdict((VERDICT_MATRIX[impact] || {})[evidence], 'verify');

  if (verdict === 'publish') {
    const reason =
      `Материальный риск для ГП: влияние ${IMPACT_RU[impact]} ` +
      `(${dimensionsRu(dims)}), ${EVIDENCE_RU[evidence]}.${tail}`;
    return {
      impact_level: impact,
      evidence_level: evidence,
      impact_dimensions: dims,
      verdict,
      publication_reason: reason,
      suppression_reason: null,
      verdict_reason: reason,
      suppression_flags: [],
    };
  }

  if (verdict === 'verify') {
    const reason =
      `Требует проверки: влияние ${IMPACT_RU[impact]} (${dimensionsRu(dims)}), ` +
      `но ${EVIDENCE_RU[evidence]} — доказательств для публикации недостаточно.${tail}`;
    return {
      impact_level: impact,
      evidence_level: evidence,
      impact_dimensions: dims,
      verdict,
      publication_reason: null,
      suppression_reason: null,
      verdict_reason: reason,
      suppression_flags: [],
    };
  }

  // suppress по матрице — влияние ниже материального порога (правило 5).
  const reason = `${SUPPRESSION_RU.no_impact} (влияние ${IMPACT_RU[impact]}).${tail}`;
  return {
    impact_level: impact,
    evidence_level: evidence,
    impact_dimensions: dims,
    verdict: 'suppress',
    publication_reason: null,
    suppression_reason: reason,
    verdict_reason: `Скрыто: ${reason}`,
    suppression_flags: ['no_impact'],
  };
}

// --- Требуемое действие ------------------------------------------------------

// Что инженеру делать с замечанием. Детерминированно от вердикта + предложенного
// действия агента + измерений влияния.
function resolveRequiredAction({
  verdict,
  suggestedAction = null,
  dimensions = [],
} = {}) {
  const v = normalizeVerdict(verdict, 'verify');
  if (v === 'suppress') return 'none';
  // verify: сначала подтвердить факт у заказчика, правку готовить рано.
  if (v === 'verify') return 'ask_customer';

  const action = canonicalAction(suggestedAction, ACTIONS.COMMENT);
  if (action === ACTIONS.ASSUMPTION) return 'add_assumption';
  const family = actionFamily(action);
  if (family === FAMILY.REMOVE) return 'exclude_scope';
  if (family === FAMILY.MODIFY) return 'amend_tz';
  // Семейство note: clarify/comment.
  if (action === ACTIONS.CLARIFY) return 'ask_customer';
  const dims = new Set(normalizeDimensions(dimensions));
  if (dims.has('price') || dims.has('scope')) return 'recalculate';
  if (dims.has('contract') || dims.has('payment') || dims.has('responsibility')) return 'amend_tz';
  return 'ask_customer';
}

// --- Доказательность по структурным фактам ----------------------------------

// Уровень доказательности из СТРУКТУРЫ находки, без confidence модели (правило 4):
//   anchored       — есть дословная привязка к тексту ТЗ (абзац + диапазон);
//   hasBasis       — есть обоснование (почему это проблема);
//   corroboration  — сколько НЕЗАВИСИМЫХ источников подтверждают (число разных
//                    signal_type / сигналов группы; 1 = один источник).
// Без привязки к тексту ТЗ или без обоснования доказательность не выше weak:
// «где-то в ТЗ, наверное, есть» — это предположение, а не доказательство.
function structuralEvidence({ anchored = false, hasBasis = false, corroboration = 1 } = {}) {
  if (!anchored || !hasBasis) return 'weak';
  return Number(corroboration) >= 2 ? 'strong' : 'medium';
}

// Итоговая доказательность: структурная, при необходимости ПОНИЖЕННАЯ заявленной
// агентом. Заявленное значение поднять структурную оценку НЕ может (fail-closed):
// модель не вправе объявить «strong» там, где нет ни цитаты, ни обоснования.
function resolveEvidence({ anchored, hasBasis, corroboration, declared = null } = {}) {
  const structural = structuralEvidence({ anchored, hasBasis, corroboration });
  if (declared == null || declared === '') return structural;
  return weakerEvidence(structural, normalizeEvidenceLevel(declared, structural));
}

// --- Легаси-миграция ---------------------------------------------------------

// Перенос строки ПРЕЖНЕЙ модели (display_priority + show_to_engineer) в новую.
// Правило безопасности: то, что инженер видел как важное, остаётся видимым;
// всё остальное уходит на проверку/в скрытые, но НЕ удаляется. Вердикт при этом
// считает ТА ЖЕ матрица — миграция не создаёт исключений из правил.
//   critical|high → impact critical|high + evidence medium → publish
//   medium        → impact medium      + evidence weak     → verify
//   low|нет       → impact low         + evidence weak     → suppress
function fromLegacyPriority({ displayPriority = null, shownToEngineer = null, dimensions = [] } = {}) {
  const impact = normalizeImpactLevel(displayPriority, 'low');
  const hidden = shownToEngineer === false || shownToEngineer === 0;
  const effectiveImpact = hidden ? 'low' : impact;
  const evidence = impactRank(effectiveImpact) >= impactRank('high') ? 'medium' : 'weak';
  const resolved = resolveVerdict({
    impactLevel: effectiveImpact,
    evidenceLevel: evidence,
    dimensions,
    note: `${LEGACY_REASON_PREFIX} (прежний приоритет: ${displayPriority || '—'}).`,
  });
  return {
    ...resolved,
    required_action: resolveRequiredAction({ verdict: resolved.verdict, dimensions: resolved.impact_dimensions }),
  };
}

module.exports = {
  // словари
  IMPACT_LEVELS,
  EVIDENCE_LEVELS,
  VERDICTS,
  IMPACT_DIMENSIONS,
  REQUIRED_ACTIONS,
  SUPPRESSION_FLAGS,
  MATERIAL_IMPACT_MIN,
  VERDICT_MATRIX,
  IMPACT_RU,
  EVIDENCE_RU,
  DIMENSION_RU,
  SUPPRESSION_RU,
  REQUIRED_ACTION_RU,
  LEGACY_REASON_PREFIX,
  // нормализация
  normalizeImpactLevel,
  normalizeEvidenceLevel,
  normalizeVerdict,
  normalizeRequiredAction,
  normalizeDimensions,
  normalizeSuppressionFlags,
  // сравнение/агрегация
  impactRank,
  evidenceRank,
  verdictRank,
  strongerImpact,
  strongerEvidence,
  weakerEvidence,
  maxImpact,
  maxEvidence,
  strongestVerdict,
  mergeDimensions,
  isMaterialImpact,
  dimensionsRu,
  // решение
  resolveVerdict,
  resolveRequiredAction,
  structuralEvidence,
  resolveEvidence,
  fromLegacyPriority,
};
