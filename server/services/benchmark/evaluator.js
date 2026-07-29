'use strict';

// КЛАССИФИКАЦИЯ результата агента против эталона одного документа.
//
// Каждая ОПУБЛИКОВАННАЯ находка агента получает ровно один класс:
//   tp             — закрыла эталонное замечание (жадное 1:1-назначение по
//                    убыванию score: один эталон закрывается одной находкой);
//   duplicate      — подходит под эталон, который уже закрыт другой находкой
//                    (тот же риск повторён — напр., разными стадиями);
//   informational  — совпала с замечанием из списка «не должно публиковаться»
//                    (утечка информационного/нематериального в основной поток);
//   false_positive — не совпала ни с чем.
// Поверх класса — ортогональные флаги:
//   unsupported    — нет опоры: цитата не находится в документе ИЛИ нет
//                    основания (зеркало structuralEvidence из materiality);
//   no_consequence — не названо конкретное бизнес-последствие (ни одного
//                    измерения влияния ни в полях, ни в тексте основания).
// Неопубликованные находки в точность не входят, но участвуют в диагностике
// false negative: «нашёл, но не опубликовал» — отдельная причина пропуска.
//
// Чистый модуль: без БД, без сети, без LLM.

const matcher = require('./matcher');
const { normalizeDimensions, impactRank } = require('../review/materiality');

function findingFlags(f) {
  const dims = normalizeDimensions([
    ...(Array.isArray(f.impact_dimensions) ? f.impact_dimensions : [f.impact_dimensions]),
    f.basis,
    f.summary,
  ]);
  return {
    unsupported: !f.anchored || !f.basis,
    no_consequence: dims.length === 0,
  };
}

// evaluateDocument({ documentId, sourceText, expected, forbidden, findings })
// → снимок классификации: списки tp/fp/fn/duplicate/informational/unsupported
//   с причинами несовпадения + счётчики для метрик.
function evaluateDocument({
  documentId,
  sourceText,
  expected = [],
  forbidden = [],
  findings = [],
} = {}) {
  const doc = matcher.prepareDocument(sourceText);
  const exp = expected.map((e) => matcher.prepareExpected(e, doc));
  const forb = forbidden.map((e) => matcher.prepareForbidden(e, doc));
  const all = findings.map((f, i) => matcher.prepareFinding(f, i, doc));
  const published = all
    .filter((f) => f.published)
    .sort((a, b) => a.rank - b.rank || String(a.id).localeCompare(String(b.id)));

  // Все годные пары (находка, эталон); жадное назначение по убыванию score.
  const pairs = [];
  published.forEach((f, fi) => {
    exp.forEach((e, ei) => {
      const m = matcher.matchScore(f, e);
      if (m.eligible) pairs.push({ fi, ei, score: m.score, axes: m.axes });
    });
  });
  pairs.sort((a, b) => b.score - a.score || a.fi - b.fi || a.ei - b.ei);

  const findingAssign = new Map(); // fi → pair
  const expectedAssign = new Map(); // ei → fi
  for (const p of pairs) {
    if (findingAssign.has(p.fi) || expectedAssign.has(p.ei)) continue;
    findingAssign.set(p.fi, p);
    expectedAssign.set(p.ei, p.fi);
  }

  const truePositives = [];
  const duplicates = [];
  const informational = [];
  const falsePositives = [];
  const rankedClasses = [];
  const unsupported = [];
  const noConsequence = [];

  published.forEach((f, fi) => {
    const flags = findingFlags(f);
    if (flags.unsupported) unsupported.push(f.id);
    if (flags.no_consequence) noConsequence.push(f.id);

    if (findingAssign.has(fi)) {
      const p = findingAssign.get(fi);
      const e = exp[p.ei];
      if (e.required_basis && !f.basis) flags.missing_required_basis = true;
      if (e.expected_impact && f.impact_level
        && impactRank(f.impact_level) < impactRank(e.expected_impact)) {
        flags.impact_below_expected = true;
      }
      truePositives.push({
        finding_id: f.id,
        expected_id: e.id,
        rank: f.rank,
        score: p.score,
        axes: p.axes,
        flags,
      });
      rankedClasses.push('tp');
      return;
    }

    // Дубль: годная пара есть, но эталон уже закрыт другой находкой.
    const dup = pairs.filter((p) => p.fi === fi)[0];
    if (dup) {
      duplicates.push({
        finding_id: f.id,
        duplicate_of_expected: exp[dup.ei].id,
        rank: f.rank,
        score: dup.score,
        flags,
      });
      rankedClasses.push('duplicate');
      return;
    }

    // Утечка: совпала с запрещённым к публикации.
    let bestForb = null;
    for (const e of forb) {
      const m = matcher.matchScore(f, e);
      if (m.eligible && (!bestForb || m.score > bestForb.score)) {
        bestForb = { forbidden_id: e.id, reason: e.reason, score: m.score };
      }
    }
    if (bestForb) {
      informational.push({
        finding_id: f.id,
        forbidden_id: bestForb.forbidden_id,
        forbidden_reason: bestForb.reason,
        rank: f.rank,
        score: bestForb.score,
        flags,
      });
      rankedClasses.push('informational');
      return;
    }

    // False positive + причины по ближайшему эталону.
    let nearest = null;
    for (const e of exp) {
      const m = matcher.matchScore(f, e);
      if (!nearest || m.score > nearest.score) {
        nearest = { expected_id: e.id, score: m.score, axes: m.axes };
      }
    }
    falsePositives.push({
      finding_id: f.id,
      rank: f.rank,
      flags,
      nearest_expected: nearest,
      reasons: nearest
        ? matcher.failedAxes(nearest.axes, nearest.score)
        : ['no_expected_in_document'],
    });
    rankedClasses.push('false_positive');
  });

  // False negative: незакрытые эталоны + диагностика лучшего кандидата.
  const falseNegatives = [];
  exp.forEach((e, ei) => {
    if (expectedAssign.has(ei)) return;
    let best = null;
    let bestFinding = null;
    for (const f of all) {
      const m = matcher.matchScore(f, e);
      if (!best || m.score > best.score) {
        best = m;
        bestFinding = f;
      }
    }
    let reasons;
    if (!all.length) reasons = ['no_findings'];
    else if (best.eligible && !bestFinding.published) reasons = ['found_but_not_published'];
    else if (best.eligible) reasons = ['matched_to_other_expected'];
    else reasons = matcher.failedAxes(best.axes, best.score);
    falseNegatives.push({
      expected_id: e.id,
      kind: e.kind,
      expected_impact: e.expected_impact,
      engineer_comment: e.engineer_comment,
      reasons,
      best_candidate: bestFinding
        ? {
          finding_id: bestFinding.id,
          published: bestFinding.published,
          score: best.score,
          axes: best.axes,
        }
        : null,
    });
  });

  const criticalIdx = exp
    .map((e, ei) => ({ e, ei }))
    .filter(({ e }) => e.kind === 'critical');

  return {
    document_id: documentId,
    published_count: published.length,
    unpublished_count: all.length - published.length,
    expected_total: exp.length,
    expected_matched: expectedAssign.size,
    expected_critical_total: criticalIdx.length,
    expected_critical_matched: criticalIdx.filter(({ ei }) => expectedAssign.has(ei)).length,
    true_positives: truePositives,
    duplicates,
    informational,
    false_positives: falsePositives,
    false_negatives: falseNegatives,
    unsupported,
    no_consequence: noConsequence,
    ranked_classes: rankedClasses,
  };
}

module.exports = { evaluateDocument, findingFlags };
