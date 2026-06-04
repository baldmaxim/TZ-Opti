'use strict';

// Quality scoring + negative patterns для находок Стадии 4 (типовые риски).
// Чистая функция без БД/LLM — тестируется отдельно (stage4Scoring.test.js).
//
// Идея: LLM может «дотягивать» слабые/ложные совпадения с библиотекой рисков.
// Здесь мы оцениваем каждую находку по сходящимся сигналам и отбрасываем мусор:
//   • риск, которого нет в справочнике (галлюцинация ключа);
//   • срабатывание анти-триггера риска (контекст, где это НЕ риск);
//   • бедное обоснование / неспецифичная цитата / завышенная критичность.
// На выходе — { score: 0..1, drop, reason }. Порог — STAGE4_MIN_SCORE (env).

const { normalize } = require('./shared/fragmentMatcher');

// Денежно-объёмные маркеры: хороший basis для Стадии 4 называет ЭКОНОМИЧЕСКОЕ
// последствие для ГП. Наличие маркера — сигнал качества обоснования.
const ECONOMIC_MARKERS = [
  'деньг', 'оплат', 'неоплач', 'стоимост', 'цен', 'затрат', 'расход', 'убыт',
  'объ', 'работ', 'срок', 'график', 'штраф', 'удержан', 'ответствен', 'риск', 'бесплатн',
];

const CRIT_RANK = { low: 1, medium: 2, high: 3, critical: 4 };

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
 * @returns {{ score:number, drop:boolean, reason:string }}
 */
function scoreStage4Finding({ finding, risk }) {
  const f = finding || {};
  const fragment = (f.fragment || '').trim();

  // 1. Жёсткие отбраковки.
  if (!risk) {
    return { score: 0, drop: true, reason: 'риск вне справочника (matched_risk_key не найден)' };
  }
  if (!fragment) {
    return { score: 0, drop: true, reason: 'пустая цитата' };
  }
  const fragNorm = normalize(fragment);
  if (hasAny(fragNorm, risk.negative_triggers)) {
    return { score: 0, drop: true, reason: 'сработал анти-триггер риска (контекст не является риском)' };
  }

  // 2. Базовый счёт — уверенность модели.
  const conf = clamp01(typeof f.confidence === 'number' ? f.confidence : 0.5);
  let score = conf;

  // 3. Специфичность цитаты: слишком короткая/общая — штраф; внятная длина — бонус.
  if (fragment.length < 12) score -= 0.25;
  else if (fragment.length >= 25) score += 0.05;

  // 4. Качество basis: пустое/короткое — штраф; называет эконом-последствие — бонус.
  const basis = (f.basis || '').trim();
  if (basis.length < 20) score -= 0.2;
  if (hasAny(normalize(basis), ECONOMIC_MARKERS)) score += 0.1;
  else score -= 0.1; // тема без денежного следа — слабее

  // 5. Завышенная критичность относительно риска — лёгкий штраф.
  const fRank = CRIT_RANK[(f.criticality || '').toLowerCase()] || 0;
  const rRank = CRIT_RANK[(risk.criticality || '').toLowerCase()] || 0;
  if (fRank && rRank && fRank > rRank + 1) score -= 0.1;

  score = clamp01(score);
  const threshold = minScore();
  if (score < threshold) {
    return { score, drop: true, reason: `score ${score.toFixed(2)} < порога ${threshold.toFixed(2)}` };
  }
  return { score, drop: false, reason: '' };
}

module.exports = { scoreStage4Finding, minScore, ECONOMIC_MARKERS };
