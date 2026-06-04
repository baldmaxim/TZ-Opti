'use strict';

// Quality scoring Стадии 4 (типовые риски) — потребитель детерминированных
// сигналов из stage4RuleSignals.js. Финальное решение по issue принимает LLM;
// здесь его находки оцениваются по сходящимся объективным сигналам и
// фильтруется мусор:
//   • риск вне справочника (галлюцинация ключа) → drop;
//   • анти-паттерн риска в контексте (negative pattern) → подавление (drop);
//   • сила совпадения триггеров: точное → буст, несколько → больше буст,
//     слабое/без триггера → штраф;
//   • бедное обоснование / неспецифичная цитата / завышенная критичность → штраф;
//   • вес риска confidence_weight (для «шумных» рисков).
// На выходе — { score, drop, reason, suppressedByNegative, signals }.
// Порог отсева — STAGE4_MIN_SCORE (env, дефолт 0.45). Чистый модуль (без БД/LLM).

const { normalize } = require('./shared/fragmentMatcher');
const { computeRuleSignals } = require('./stage4RuleSignals');

// Денежно-объёмные маркеры: хороший basis называет ЭКОНОМИЧЕСКОЕ последствие
// для ГП (деньги/объём/срок), а не общую формулировку.
const ECONOMIC_MARKERS = [
  'деньг', 'оплат', 'неоплач', 'стоимост', 'цен', 'затрат', 'расход', 'убыт',
  'объ', 'срок', 'график', 'штраф', 'удержан', 'ответствен', 'бесплатн', 'за свой счёт', 'за свой счет',
];

const CRIT_RANK = { low: 1, medium: 2, high: 3, critical: 4 };

// Явные fallback-штрафы/бонусы (помимо delta по силе совпадения из сигналов).
const PENALTY = {
  shortBasis: -0.2, // basis короче 20 символов
  noEconomic: -0.1, // basis без денежно-объёмного маркера
  hasEconomic: 0.1, // basis с маркером
  shortFragment: -0.15, // цитата короче 12 символов
  overCriticality: -0.1, // критичность находки выше риска более чем на ступень
};

function minScore() {
  const v = Number(process.env.STAGE4_MIN_SCORE);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.45;
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function hasAny(haystackNorm, phrases) {
  for (const p of phrases || []) {
    const np = normalize(p);
    if (np && haystackNorm.includes(np)) return true;
  }
  return false;
}

/**
 * Оценка одной находки Стадии 4.
 * @param {object} finding — сырая находка LLM (fragment, matched_risk_key, basis,
 *   review_comment, criticality, confidence).
 * @param {object|null} risk — риск из справочника по matched_risk_key (или null).
 * @returns {{ score:number, drop:boolean, reason:string,
 *             suppressedByNegative:boolean, signals?:object }}
 */
function scoreStage4Finding({ finding, risk }) {
  const f = finding || {};
  const fragment = (f.fragment || '').trim();

  // 1. Жёсткие отбраковки.
  if (!risk) {
    return { score: 0, drop: true, reason: 'риск вне справочника (matched_risk_key не найден)', suppressedByNegative: false };
  }
  if (!fragment) {
    return { score: 0, drop: true, reason: 'пустая цитата', suppressedByNegative: false };
  }

  // 2. Детерминированные сигналы (триггеры / анти-паттерны / сила совпадения).
  const signals = computeRuleSignals({ finding: f, risk });

  // Анти-паттерн в контексте → подавляем находку (negative pattern suppression).
  if (signals.hasStrongNegative) {
    return {
      score: 0,
      drop: true,
      reason: `подавлено анти-паттерном (${signals.negatives.map((n) => `«${n}»`).join(', ')})`,
      suppressedByNegative: true,
      signals,
    };
  }

  // 3. База — уверенность модели + дельта по силе совпадения (точное/множественное
  //    повышает, слабое/без триггера понижает).
  const conf = clamp01(typeof f.confidence === 'number' ? f.confidence : 0.5);
  let score = conf + signals.delta;

  // 4. Качество basis.
  const basis = (f.basis || '').trim();
  if (basis.length < 20) score += PENALTY.shortBasis;
  score += hasAny(normalize(basis), ECONOMIC_MARKERS) ? PENALTY.hasEconomic : PENALTY.noEconomic;

  // 5. Специфичность цитаты.
  if (fragment.length < 12) score += PENALTY.shortFragment;

  // 6. Завышенная критичность относительно риска.
  const fRank = CRIT_RANK[(f.criticality || '').toLowerCase()] || 0;
  const rRank = CRIT_RANK[(risk.criticality || '').toLowerCase()] || 0;
  if (fRank && rRank && fRank > rRank + 1) score += PENALTY.overCriticality;

  // 7. Вес риска (confidence_weight) — множитель для «шумных» рисков.
  const weight = typeof risk.confidence_weight === 'number' ? risk.confidence_weight : 1;
  score = clamp01(clamp01(score) * weight);

  const threshold = minScore();
  if (score < threshold) {
    return {
      score,
      drop: true,
      reason: `score ${score.toFixed(2)} < порога ${threshold.toFixed(2)} [${signals.matchKind}]`,
      suppressedByNegative: false,
      signals,
    };
  }
  return { score, drop: false, reason: '', suppressedByNegative: false, signals };
}

module.exports = { scoreStage4Finding, minScore, ECONOMIC_MARKERS };
