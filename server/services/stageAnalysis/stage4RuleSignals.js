'use strict';

// Детерминированный слой СИГНАЛОВ для Стадии 4 (вспомогательный к LLM-агенту).
//
// Финальное решение по issue принимает LLM (stage4_llm.js). Этот модуль НЕ
// создаёт issue сам — он считает по фрагменту ТЗ и риску из справочника
// объективные сигналы (precheck триггеров, анти-паттерны, сила совпадения),
// которые scoring (stage4Scoring.js) превращает в бусты/штрафы confidence,
// подавление ложных срабатываний и explainability.
//
// Переиспользует идею матчинга из legacy rule-based stage4_risks.js
// (триггеры через fragmentMatcher), но как сигнал, а не как самостоятельную стадию.
// Чистый модуль без БД/LLM — тестируется отдельно.

const { normalize, tokens } = require('./shared/fragmentMatcher');

// Доля значимых токенов триггера, достаточная для «слабого» совпадения.
const WEAK_TOKEN_RATIO = 0.6;

// Бусты/штрафы уверенности по силе совпадения (явные значения — fallback'и).
const DELTA = {
  exactBase: 0.1, // одно точное совпадение триггера
  perExtraPositive: 0.05, // каждое доп. точное совпадение
  extraPositiveCap: 0.1, // потолок бонуса за множественность
  weakOnly: -0.1, // только слабое (token-overlap) совпадение
  none: -0.15, // ни одного триггера (LLM нашёл «по смыслу» — меньше опоры)
};

// Дефолтное действие по типу (категории) риска — чтобы suggested_action не был
// одинаковым для всех рисков. LLM может вернуть своё; это fallback.
const ACTION_BY_CATEGORY = {
  'Объём работ': 'limit_scope',
  'Проект и исходные данные': 'clarify',
  'Площадка и доступ': 'clarify',
  Сроки: 'clarify',
  'Материалы и временные схемы': 'limit_scope',
  'Качество и приёмка': 'clarify',
  'Цена и изменения': 'clarify',
  'Ответственность и гарантии': 'limit_scope',
};

function actionForRisk(risk) {
  return (risk && ACTION_BY_CATEGORY[risk.category]) || 'comment';
}

function negativePatternsOf(risk) {
  return (risk && (risk.negative_patterns || risk.negative_triggers)) || [];
}

// Слабое совпадение: ≥ WEAK_TOKEN_RATIO значимых токенов триггера присутствуют
// во фрагменте (порядок не важен) — ловит перефразировки без точного вхождения.
function isWeakHit(fragTokenSet, trigger) {
  const tt = tokens(trigger);
  if (!tt.length) return false;
  let present = 0;
  for (const t of tt) if (fragTokenSet.has(t)) present += 1;
  return present / tt.length >= WEAK_TOKEN_RATIO;
}

/**
 * Сигналы для (finding, risk).
 * @returns {{
 *   positives: string[], positiveCount: number, weakHits: string[],
 *   matchKind: 'exact'|'weak'|'none', negatives: string[],
 *   hasStrongNegative: boolean, delta: number, explain: string
 * }}
 */
function computeRuleSignals({ finding, risk }) {
  const fragment = (finding && finding.fragment) || '';
  const fragNorm = normalize(fragment);
  const fragTokenSet = new Set(tokens(fragment));

  const triggers = (risk && risk.triggers) || [];
  const positives = [];
  const weakCandidates = [];
  for (const trig of triggers) {
    if (!trig) continue;
    if (fragNorm.includes(normalize(trig))) positives.push(trig);
    else weakCandidates.push(trig);
  }
  const weakHits = weakCandidates.filter((t) => isWeakHit(fragTokenSet, t));

  const negatives = negativePatternsOf(risk).filter(
    (n) => n && fragNorm.includes(normalize(n)),
  );

  let matchKind = 'none';
  let delta = DELTA.none;
  if (positives.length) {
    matchKind = 'exact';
    delta = DELTA.exactBase
      + Math.min(DELTA.extraPositiveCap, DELTA.perExtraPositive * (positives.length - 1));
  } else if (weakHits.length) {
    matchKind = 'weak';
    delta = DELTA.weakOnly;
  }

  const parts = [];
  if (positives.length) parts.push(`триггеры: ${positives.map((t) => `«${t}»`).join(', ')}`);
  else if (weakHits.length) parts.push(`слабое совпадение: ${weakHits.map((t) => `«${t}»`).join(', ')}`);
  else parts.push('прямых триггеров нет (совпадение по смыслу)');
  if (negatives.length) parts.push(`анти-паттерн: ${negatives.map((t) => `«${t}»`).join(', ')}`);

  return {
    positives,
    positiveCount: positives.length,
    weakHits,
    matchKind,
    negatives,
    hasStrongNegative: negatives.length > 0,
    delta,
    explain: parts.join('; '),
  };
}

module.exports = { computeRuleSignals, actionForRisk, negativePatternsOf, DELTA, WEAK_TOKEN_RATIO };
