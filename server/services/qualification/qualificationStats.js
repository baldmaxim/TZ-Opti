'use strict';

// Агрегированная статистика SHADOW-режима квалификационного gate по одному
// прогону: как соотносятся квалификации gate с решениями инженера.
//
// ЧИСТЫЙ модуль (без БД, сети и LLM) — считается по уже РАЗОБРАННЫМ строкам
// finding_qualifications (evaluations) и finding_qualification_decisions
// (decisions). Ничего не пишет и не меняет: shadow-статистика читает shadow-слой.
//
// Ключевая договорённость (п.7 ТЗ): review НЕ считается скрытым результатом —
// retained findings это publish + review; скрывающие исходы gate — hide и reject.

const RETAINED_QUALIFICATIONS = Object.freeze(['publish', 'review']);
const HIDDEN_QUALIFICATIONS = Object.freeze(['hide', 'reject']);
const RETAINED_DECISIONS = Object.freeze(['accepted', 'accepted_with_edit']);
// Решения без вердикта о судьбе замечания: с квалификацией gate не сопоставимы.
const NEUTRAL_DECISIONS = Object.freeze(['deferred', 'merged']);

const EVALUATION_FAILED = 'evaluation_failed';

const QUALIFICATION_KEYS = Object.freeze(['publish', 'review', 'hide', 'reject', EVALUATION_FAILED]);
const DECISION_KEYS = Object.freeze(['accepted', 'accepted_with_edit', 'rejected', 'deferred', 'merged']);

// Совпало ли решение инженера с квалификацией gate.
//   1  — совпало (оба «оставить» либо оба «скрыть/отклонить»);
//   0  — разошлось (в т.ч. false hide / false reject);
//   null — не сопоставимо (deferred/merged, оценки нет, оценка не посчиталась).
function decisionAgreement(qualification, decision) {
  if (!qualification || qualification === EVALUATION_FAILED) return null;
  if (!decision || NEUTRAL_DECISIONS.includes(decision)) return null;
  const gateRetains = RETAINED_QUALIFICATIONS.includes(qualification);
  if (decision === 'rejected') return gateRetains ? 0 : 1;
  if (RETAINED_DECISIONS.includes(decision)) return gateRetains ? 1 : 0;
  return null;
}

// Последнее решение инженера на кластер (append-only журнал: актуальное —
// последнее по decided_at; при равенстве побеждает более поздняя строка).
function latestDecisionsByCluster(decisions = []) {
  const map = new Map();
  for (const d of decisions) {
    if (!d || !d.cluster_id) continue;
    const prev = map.get(d.cluster_id);
    if (!prev || String(d.decided_at || '') >= String(prev.decided_at || '')) {
      map.set(d.cluster_id, d);
    }
  }
  return map;
}

const zeroQualifications = () =>
  Object.fromEntries(QUALIFICATION_KEYS.map((k) => [k, 0]));
const zeroDecisions = () => Object.fromEntries(DECISION_KEYS.map((k) => [k, 0]));

const round3 = (n) => Number(n.toFixed(3));

// Доля принятых среди решённых по существу (accepted + accepted_with_edit +
// rejected). deferred/merged — не вердикт, в знаменатель не входят.
function acceptanceRate(bucket) {
  const decided = bucket.accepted + bucket.accepted_with_edit + bucket.rejected;
  if (!decided) return null;
  return round3((bucket.accepted + bucket.accepted_with_edit) / decided);
}

function bucketFor(map, key) {
  if (!map[key]) {
    map[key] = { total: 0, ...zeroQualifications(), decided: 0, ...zeroDecisions() };
  }
  return map[key];
}

function countInBucket(bucket, ev, decision) {
  bucket.total += 1;
  const q = QUALIFICATION_KEYS.includes(ev.qualification) ? ev.qualification : EVALUATION_FAILED;
  bucket[q] += 1;
  if (decision && DECISION_KEYS.includes(decision.decision)) {
    bucket.decided += 1;
    bucket[decision.decision] += 1;
  }
}

// Статистика прогона. evaluations — строки ОДНОЙ версии gate одного прогона
// (JSON-поля уже разобраны: impact_types/source_stages — массивы); decisions —
// ВСЕ решения инженера по кластерам прогона (актуальное выбирается здесь).
function computeRunStats({ evaluations = [], decisions = [] } = {}) {
  const latest = latestDecisionsByCluster(decisions);

  const qualifications = zeroQualifications();
  const decisionCounts = zeroDecisions();
  const acceptance = {};
  const agreement = { match: 0, mismatch: 0, not_comparable: 0 };
  const falseHide = [];
  const falseReject = [];
  const rejectionReasons = {};
  const editReasons = {};
  const byCategory = {};
  const byStage = {};
  const priorityPairs = new Map();
  let priorityComparable = 0;
  let priorityMismatches = 0;
  let decidedTotal = 0;

  for (const ev of evaluations) {
    const q = QUALIFICATION_KEYS.includes(ev.qualification) ? ev.qualification : EVALUATION_FAILED;
    qualifications[q] += 1;

    const d = latest.get(ev.cluster_id) || null;
    if (d && DECISION_KEYS.includes(d.decision)) {
      decidedTotal += 1;
      decisionCounts[d.decision] += 1;
      if (d.decision === 'rejected' && d.reason_code) {
        rejectionReasons[d.reason_code] = (rejectionReasons[d.reason_code] || 0) + 1;
      }
      if (d.decision === 'accepted_with_edit' && d.reason_code) {
        editReasons[d.reason_code] = (editReasons[d.reason_code] || 0) + 1;
      }
    }

    // Соответствие gate ↔ инженер.
    const agree = decisionAgreement(q, d ? d.decision : null);
    if (agree === 1) agreement.match += 1;
    else if (agree === 0) agreement.mismatch += 1;
    else agreement.not_comparable += 1;

    // false hide / false reject: gate скрыл или отклонил, а инженер оставил.
    if (d && RETAINED_DECISIONS.includes(d.decision)) {
      if (q === 'hide') falseHide.push(ev.cluster_id);
      if (q === 'reject') falseReject.push(ev.cluster_id);
    }

    // Acceptance по квалификации.
    countInBucket(bucketFor(acceptance, q), ev, d);

    // Расхождение приоритета: только там, где обе стороны названы и оценка
    // посчиталась. Сравнение по строке (шкалы разные сознательно: gate может
    // предложить informational, которого нет в production).
    if (q !== EVALUATION_FAILED && ev.proposed_priority && ev.production_priority) {
      priorityComparable += 1;
      if (ev.proposed_priority !== ev.production_priority) {
        priorityMismatches += 1;
        const key = `${ev.proposed_priority}->${ev.production_priority}`;
        priorityPairs.set(key, (priorityPairs.get(key) || 0) + 1);
      }
    }

    // Разрез по категории и по стадиям-источникам (кластер может быть собран
    // из находок нескольких стадий — считается в каждой).
    countInBucket(bucketFor(byCategory, ev.category || 'other'), ev, d);
    const stages = Array.isArray(ev.source_stages) && ev.source_stages.length
      ? ev.source_stages : ['unknown'];
    for (const s of stages) countInBucket(bucketFor(byStage, String(s)), ev, d);
  }

  for (const bucket of [
    ...Object.values(acceptance), ...Object.values(byCategory), ...Object.values(byStage),
  ]) {
    bucket.acceptance_rate = acceptanceRate(bucket);
  }

  const editedDenom = decisionCounts.accepted + decisionCounts.accepted_with_edit;

  return {
    total: evaluations.length,
    qualifications,
    retained_by_gate: qualifications.publish + qualifications.review,
    hidden_by_gate: qualifications.hide + qualifications.reject,
    decided_total: decidedTotal,
    decisions: decisionCounts,
    acceptance_by_qualification: acceptance,
    agreement,
    false_hide: { count: falseHide.length, cluster_ids: falseHide },
    false_reject: { count: falseReject.length, cluster_ids: falseReject },
    rejection_reasons: rejectionReasons,
    edit_reasons: editReasons,
    // Доля отредактированных среди оставленных инженером замечаний.
    edited_share: editedDenom ? round3(decisionCounts.accepted_with_edit / editedDenom) : null,
    priority: {
      comparable: priorityComparable,
      mismatches: priorityMismatches,
      pairs: [...priorityPairs.entries()]
        .map(([pair, count]) => {
          const [proposed, production] = pair.split('->');
          return { proposed, production, count };
        })
        .sort((a, b) => b.count - a.count),
    },
    by_category: byCategory,
    by_stage: byStage,
  };
}

module.exports = {
  RETAINED_QUALIFICATIONS,
  HIDDEN_QUALIFICATIONS,
  RETAINED_DECISIONS,
  NEUTRAL_DECISIONS,
  EVALUATION_FAILED,
  decisionAgreement,
  latestDecisionsByCluster,
  computeRunStats,
};
