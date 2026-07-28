'use strict';

// Слой clustering — четвёртый шаг новой архитектуры анализа ТЗ
// (signals -> draft_issues -> critic -> clustering).
//
// Задача: свести ПОХОЖИЕ замечания по ОДНОМУ месту ТЗ в один кластер, чтобы
// инженер видел не россыпь отдельных draft_issues, а сгруппированную проблему
// с объединённым основанием и рекомендацией.
//
// Главное правило (НЕ терять смысл): два draft_issue объединяются только если
//   1) указывают на одно место ТЗ  — общий tz_clause ИЛИ общий фрагмент/абзац;
//   2) близки по смыслу             — совпадает доминирующее измерение значимости
//                                     (цена/срок/договор/ответственность) от critic;
//   3) пересекается действие         — одинаковое семейство suggested_action
//                                     (remove / modify / note — analysis/actions).
// Разные по смыслу проблемы в одном пункте (открытый объём ≠ риск оплаты) дают
// РАЗНЫЕ кластеры: у каждого свои cluster_items, каждый сохраняет своё основание.
//
// ПАРАЛЛЕЛЬНЫЙ слой: не трогает issues / review / export / draft_issues / critic.
// Группировка/слияние — чистые функции (тестируются без БД), как в
// review/consolidation.js и unifiedAnalysis.

const crypto = require('crypto');
const db = require('../../db/connection');
const { newId, nowIso } = require('../../utils/ids');
const { actionFamily } = require('../analysis/actions');
const analysisRuns = require('../analysisRuns/analysisRunsService');
const materiality = require('../review/materiality');

// Детерминированный id кластера от (tenderId + clusterKey). Этап 6: решения инженера
// привязываются к cluster_id, а buildClusters пересобирает кластеры (DELETE+INSERT) —
// со случайным id решение терялось бы. Хэш стабилен → решение переживает пересборку.
function clusterId(tenderId, key) {
  const h = crypto.createHash('sha1').update(`${tenderId}::${key}`).digest('hex').slice(0, 24);
  return `clu_${h}`;
}

const CRIT_RANK = { critical: 4, high: 3, medium: 2, low: 1, none: 0 };
const IMPACT_RANK = { high: 3, medium: 2, low: 1, none: 0 };

function normalize(s) {
  return (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// --- Ключи группировки ------------------------------------------------------

// Место ТЗ: один и тот же пункт (tz_clause) ИЛИ один и тот же фрагмент/абзац.
// Приоритет — нормализованный tz_clause; иначе абзац; иначе нормализованный фрагмент;
// иначе сам draft уникален (не клеим вслепую).
function placeKey(draft) {
  const clause = normalize(draft.tz_clause);
  if (clause) return `clause:${clause}`;
  if (draft.paragraph_index != null) return `para:${draft.paragraph_index}`;
  const frag = normalize(draft.source_fragment);
  if (frag) return `frag:${frag}`;
  return `uniq:${draft.id}`;
}

// Доминирующее измерение значимости от critic (по убыванию приоритета при равенстве).
function dominantDimension(review) {
  const dims = [
    ['contract', review && review.contract_impact],
    ['responsibility', review && review.responsibility_impact],
    ['price', review && review.price_impact],
    ['schedule', review && review.schedule_impact],
  ];
  let best = 'general';
  let bestRank = 0;
  for (const [name, level] of dims) {
    const r = IMPACT_RANK[level] || 0;
    if (r > bestRank) { bestRank = r; best = name; }
  }
  return best; // contract|responsibility|price|schedule|general
}

// Смысловой ключ: измерение значимости + семейство действия (единый реестр
// analysis/actions: remove | modify | note). Разделяет «открытый объём»
// (price/responsibility + modify/remove) и «риск оплаты» (contract + note/modify)
// даже в одном пункте ТЗ. actionFamily берёт suggested_action и, в частности,
// НЕ роняет replace/limit_scope в note (легаси edit → replace → modify).
function semanticBucket(draft, review) {
  return `${dominantDimension(review)}|${actionFamily(draft.suggested_action)}`;
}

function clusterKey(draft, review) {
  return `${placeKey(draft)}::${semanticBucket(draft, review)}`;
}

// --- Сборка кластера --------------------------------------------------------

const DIM_LABEL = {
  contract: 'Договорное условие',
  responsibility: 'Обязанность/ответственность ГП',
  price: 'Влияние на стоимость',
  schedule: 'Влияние на срок',
  general: 'Замечание по ТЗ',
};

function critOf(pair) { return CRIT_RANK[pair.review && pair.review.display_priority] || 0; }
function scoreOf(pair) { return (pair.review && typeof pair.review.score === 'number') ? pair.review.score : 0; }

// Первичный (наиболее значимый) элемент кластера: критичность -> score ->
// порядок абзаца -> стабильный id.
function pickPrimary(pairs) {
  return [...pairs].sort(
    (a, b) =>
      critOf(b) - critOf(a) ||
      scoreOf(b) - scoreOf(a) ||
      ((a.draft.paragraph_index ?? 1e9) - (b.draft.paragraph_index ?? 1e9)) ||
      String(a.draft.id).localeCompare(String(b.draft.id)),
  )[0];
}

function uniqueJoin(values, sep) {
  const seen = new Set();
  const out = [];
  for (const v of values) {
    const t = (v || '').trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out.join(sep);
}

// Свёртка материальности кластера по его элементам.
//   verdict  — СИЛЬНЕЙШИЙ по набору (publish > verify > suppress): кластер значим,
//              если значим хотя бы один его элемент, и уходит в скрытые только
//              когда все элементы скрыты.
//   impact / evidence — максимум по элементам.
//   dimensions — объединение измерений всех элементов.
//   причины и required_action — от РЕШАЮЩЕГО элемента (того, чей вердикт стал
//              вердиктом кластера), иначе инженер читал бы причину скрытой
//              редактуры рядом с опубликованным риском.
// Элементы без вердикта (critic не прогонялся) не считаются нематериальными:
// вердикт кластера тогда verify — «не оценено» это не «влияния нет».
function clusterMateriality(pairs) {
  const withVerdict = pairs.filter((p) => p.review && p.review.verdict);
  const dims = materiality.mergeDimensions(
    ...pairs.map((p) => (p.review && p.review.impact_dimensions) || []),
  );
  if (!withVerdict.length) {
    return {
      verdict: 'verify',
      impact_level: materiality.maxImpact(pairs.map((p) => p.review && p.review.impact_level)),
      evidence_level: materiality.maxEvidence(pairs.map((p) => p.review && p.review.evidence_level)),
      impact_dimensions: dims,
      publication_reason: null,
      suppression_reason: null,
      required_action: 'ask_customer',
    };
  }
  const verdict = materiality.strongestVerdict(withVerdict.map((p) => p.review.verdict));
  const decisive = withVerdict
    .filter((p) => p.review.verdict === verdict)
    .sort(
      (a, b) =>
        materiality.impactRank(b.review.impact_level) - materiality.impactRank(a.review.impact_level)
        || materiality.evidenceRank(b.review.evidence_level) - materiality.evidenceRank(a.review.evidence_level),
    )[0];
  return {
    verdict,
    impact_level: materiality.maxImpact(withVerdict.map((p) => p.review.impact_level)),
    evidence_level: materiality.maxEvidence(withVerdict.map((p) => p.review.evidence_level)),
    impact_dimensions: dims,
    publication_reason: decisive.review.publication_reason || null,
    suppression_reason: decisive.review.suppression_reason || null,
    required_action: materiality.normalizeRequiredAction(decisive.review.required_action, 'none'),
  };
}

function buildCluster(tenderId, pairs) {
  const primary = pickPrimary(pairs);
  const pd = primary.draft;
  const dim = dominantDimension(primary.review);

  // Объединённое основание — по пунктам, с пометкой стадии/категории, чтобы
  // были видны вклады разных стадий и не терялся смысл каждого элемента.
  const merged_basis = uniqueJoin(
    pairs.map((p) => {
      const cat = p.draft.category ? `[${p.draft.category}] ` : '';
      return cat + (p.draft.basis || p.draft.review_comment || p.draft.source_fragment || '');
    }),
    '\n• ',
  );

  const merged_recommendation = uniqueJoin(
    pairs.map((p) => p.draft.suggested_redaction || p.draft.review_comment || p.draft.suggested_action),
    '\n• ',
  );

  // Итоговая критичность кластера — максимум по элементам (display_priority critic).
  const overall_criticality = pairs
    .map((p) => p.review && p.review.display_priority)
    .sort((a, b) => (CRIT_RANK[b] || 0) - (CRIT_RANK[a] || 0))[0] || 'low';

  // Материальность кластера — свёртка по элементам (модель impact × evidence).
  const mat = clusterMateriality(pairs);

  // Кластер показываем, только если он ОПУБЛИКОВАН: инженер по умолчанию видит
  // материальные коммерческие и договорные риски, остальное — в режимах
  // «На проверку» и «Все» (ничего не удаляется).
  const show_to_engineer = mat.verdict === 'publish';

  const tz_clause = pairs.map((p) => p.draft.tz_clause).find(Boolean) || null;
  const cluster_title = `${DIM_LABEL[dim] || DIM_LABEL.general}${tz_clause ? ` — ${tz_clause}` : ''}`;

  const itemsSorted = [...pairs].sort(
    (a, b) => critOf(b) - critOf(a) || scoreOf(b) - scoreOf(a),
  );

  // Стабильный ключ группы = ключ места + смысловой bucket primary-элемента
  // (тот же clusterKey, по которому pairs были сгруппированы). Основа id и привязки решений.
  const cluster_key = clusterKey(pd, primary.review || {});

  return {
    id: clusterId(tenderId, cluster_key),
    cluster_key,
    tender_id: tenderId,
    tz_clause,
    cluster_title,
    merged_basis: merged_basis ? '• ' + merged_basis : null,
    merged_recommendation: merged_recommendation ? '• ' + merged_recommendation : null,
    overall_criticality,
    show_to_engineer,
    final_problem_type: pd.problem_type || null,
    semantic_bucket: semanticBucket(pd, primary.review),
    item_count: pairs.length,
    paragraph_index: pd.paragraph_index ?? null,
    // Модель материальности на уровне кластера (одно решение — один вердикт).
    verdict: mat.verdict,
    overall_impact_level: mat.impact_level,
    overall_evidence_level: mat.evidence_level,
    impact_dimensions: mat.impact_dimensions,
    publication_reason: mat.publication_reason,
    suppression_reason: mat.suppression_reason,
    required_action: mat.required_action,
    items: itemsSorted.map((p) => ({
      draft_issue_id: p.draft.id,
      item_role: p.draft.id === pd.id ? 'primary' : 'related',
    })),
  };
}

// Чистое ядро: пары {draft, review} -> кластеры[]. Без БД.
function clusterPairs(pairs, tenderId) {
  const byKey = new Map();
  for (const p of pairs) {
    const key = clusterKey(p.draft, p.review || {});
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(p);
  }
  const clusters = [...byKey.values()].map((group) => buildCluster(tenderId, group));
  clusters.sort(
    (a, b) =>
      (a.paragraph_index ?? 1e9) - (b.paragraph_index ?? 1e9) ||
      (CRIT_RANK[b.overall_criticality] || 0) - (CRIT_RANK[a.overall_criticality] || 0),
  );
  return clusters;
}

// --- DB-обвязка -------------------------------------------------------------

function safeParse(s, fallback) {
  if (!s) return fallback;
  try { const v = JSON.parse(s); return v == null ? fallback : v; } catch (_e) { return fallback; }
}

// JSON-массив измерений из колонки: не-массив (NULL/битая строка) → [].
function parseDimensions(s) {
  const v = safeParse(s, []);
  return Array.isArray(v) ? v : [];
}

// Грузит draft_issues тендера вместе с вердиктом critic (LEFT JOIN — кластеризуем
// даже без прогона critic: тогда review пуст и сработает дефолтный bucket).
async function loadPairs(tenderId, runId) {
  const rows = await db.queryAll(
    `SELECT d.*,
            r.display_priority, r.show_to_engineer, r.score,
            r.price_impact, r.schedule_impact, r.contract_impact, r.responsibility_impact,
            r.impact_level, r.evidence_level, r.verdict, r.impact_dimensions,
            r.publication_reason, r.suppression_reason, r.required_action
       FROM draft_issues d
       LEFT JOIN issue_reviews r ON r.draft_issue_id = d.id
      WHERE d.tender_id = ? AND d.analysis_run_id = ?
      ORDER BY d.paragraph_index ASC NULLS LAST, d.created_at ASC`,
    tenderId, runId,
  );
  return rows.map((r) => ({
    draft: {
      id: r.id,
      tz_clause: r.tz_clause,
      source_fragment: r.source_fragment,
      problem_type: r.problem_type,
      category: r.category,
      basis: r.basis,
      suggested_action: r.suggested_action,
      suggested_redaction: r.suggested_redaction,
      review_comment: r.review_comment,
      paragraph_index: r.paragraph_index,
    },
    review: r.display_priority ? {
      display_priority: r.display_priority,
      show_to_engineer: Number(r.show_to_engineer) === 1,
      score: r.score,
      price_impact: r.price_impact,
      schedule_impact: r.schedule_impact,
      contract_impact: r.contract_impact,
      responsibility_impact: r.responsibility_impact,
      impact_level: r.impact_level,
      evidence_level: r.evidence_level,
      verdict: r.verdict,
      impact_dimensions: (() => {
        const v = safeParse(r.impact_dimensions, []);
        return Array.isArray(v) ? v : [];
      })(),
      publication_reason: r.publication_reason,
      suppression_reason: r.suppression_reason,
      required_action: r.required_action,
    } : null,
  }));
}

// Главная функция: собрать кластеры тендера и сохранить (idempotent — перезапись
// прежнего набора). Возвращает summary.
// runId — прогон-КАНДИДАТ. Без него кластеры собираются в НОВЫЙ кандидат
// (указатель не двигается): одиночный build не переписывает действующий снимок.
async function buildClusters(tenderId, runId) {
  const rid = runId || await analysisRuns.beginCandidateRun(tenderId, { reason: 'clustering.build' });
  const pairs = await loadPairs(tenderId, rid);
  const clusters = clusterPairs(pairs, tenderId);

  await db.transaction(async (tx) => {
    // Страж неизменяемости снимка (см. analysisRuns.assertRunWritable).
    await analysisRuns.assertRunWritable(tenderId, rid, { kind: 'pipeline' }, tx);
    await tx.queryRun(`DELETE FROM issue_clusters WHERE tender_id = ? AND analysis_run_id = ?`, tenderId, rid);
    const createdAt = nowIso();
    for (const c of clusters) {
      // Run-scoped id кластера: стабилен внутри прогона, но НЕ совпадает между
      // прогонами → решения не приклеиваются автоматически (перенос — явный).
      const cid = analysisRuns.clusterRunId(tenderId, rid, c.cluster_key);
      await tx.queryRun(
        `INSERT INTO issue_clusters (
           id, tender_id, analysis_run_id, tz_clause, cluster_title, merged_basis, merged_recommendation,
           overall_criticality, show_to_engineer, final_problem_type,
           semantic_bucket, cluster_key, item_count, paragraph_index, created_at,
           verdict, overall_impact_level, overall_evidence_level, impact_dimensions,
           publication_reason, suppression_reason, required_action
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        cid, c.tender_id, rid, c.tz_clause, c.cluster_title, c.merged_basis, c.merged_recommendation,
        c.overall_criticality, c.show_to_engineer ? 1 : 0, c.final_problem_type,
        c.semantic_bucket, c.cluster_key, c.item_count, c.paragraph_index, createdAt,
        c.verdict, c.overall_impact_level, c.overall_evidence_level,
        JSON.stringify(c.impact_dimensions || []),
        c.publication_reason, c.suppression_reason, c.required_action,
      );
      for (const it of c.items) {
        await tx.queryRun(
          `INSERT INTO issue_cluster_items (id, cluster_id, draft_issue_id, item_role, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          newId(), cid, it.draft_issue_id, it.item_role, createdAt,
        );
      }
    }
  });

  const byCriticality = clusters.reduce((acc, c) => {
    acc[c.overall_criticality] = (acc[c.overall_criticality] || 0) + 1;
    return acc;
  }, {});

  return {
    summary: {
      run_id: rid,
      draft_issues: pairs.length,
      clusters: clusters.length,
      multi_item: clusters.filter((c) => c.item_count > 1).length,
      shown: clusters.filter((c) => c.show_to_engineer).length,
      hidden: clusters.filter((c) => !c.show_to_engineer).length,
      by_criticality: byCriticality,
      by_verdict: clusters.reduce((acc, c) => {
        acc[c.verdict] = (acc[c.verdict] || 0) + 1;
        return acc;
      }, {}),
      published: clusters.filter((c) => c.verdict === 'publish').length,
      to_verify: clusters.filter((c) => c.verdict === 'verify').length,
      suppressed: clusters.filter((c) => c.verdict === 'suppress').length,
    },
  };
}

// Режимы показа (как в critic — по вердикту модели материальности):
//   important — опубликованные с высоким влиянием;
//   working   — опубликованные (материальные) — ПО УМОЛЧАНИЮ;
//   verify    — требуют проверки;
//   full      — всё, включая скрытое.
const MODE_WHERE = {
  important: `AND c.verdict = 'publish' AND c.overall_impact_level IN ('critical','high')`,
  working: `AND c.verdict = 'publish'`,
  verify: `AND c.verdict = 'verify'`,
  full: ``,
};

// Читает кластеры + их элементы (draft_issues) одним проходом. Только АКТУАЛЬНЫЙ
// pipeline-прогон (runId по умолчанию — активный указатель); нет прогона → пусто.
async function listClusters(tenderId, mode = 'working', runId) {
  const where = MODE_WHERE[mode] != null ? MODE_WHERE[mode] : MODE_WHERE.working;
  const rid = runId || await analysisRuns.getActivePipelineRunId(tenderId);
  if (!rid) return [];
  const clusters = await db.queryAll(
    `SELECT * FROM issue_clusters c
      WHERE c.tender_id = ? AND c.analysis_run_id = ? ${where}
      ORDER BY c.paragraph_index ASC NULLS LAST, c.created_at ASC`,
    tenderId, rid,
  );
  if (!clusters.length) return [];

  const ids = clusters.map((c) => c.id);
  const placeholders = ids.map(() => '?').join(', ');
  const itemRows = await db.queryAll(
    `SELECT ci.cluster_id, ci.item_role,
            d.id AS draft_issue_id, d.category, d.problem_type, d.source_fragment,
            d.basis, d.suggested_action, d.confidence,
            r.display_priority, r.show_to_engineer,
            r.impact_level, r.evidence_level, r.verdict, r.impact_dimensions,
            r.publication_reason, r.suppression_reason, r.required_action,
            r.critic_outcome, r.critic_source
       FROM issue_cluster_items ci
       JOIN draft_issues d ON d.id = ci.draft_issue_id
       LEFT JOIN issue_reviews r ON r.draft_issue_id = d.id
      WHERE ci.cluster_id IN (${placeholders})
      ORDER BY ci.item_role ASC`,
    ...ids,
  );
  const itemsByCluster = new Map();
  for (const it of itemRows) {
    if (!itemsByCluster.has(it.cluster_id)) itemsByCluster.set(it.cluster_id, []);
    itemsByCluster.get(it.cluster_id).push({
      ...it,
      show_to_engineer: Number(it.show_to_engineer) === 1,
      impact_dimensions: parseDimensions(it.impact_dimensions),
    });
  }

  return clusters.map((c) => ({
    ...c,
    show_to_engineer: Number(c.show_to_engineer) === 1,
    impact_dimensions: parseDimensions(c.impact_dimensions),
    items: itemsByCluster.get(c.id) || [],
  }));
}

module.exports = {
  // чистое ядро (офлайн-тесты/демо)
  clusterId,
  placeKey,
  dominantDimension,
  clusterMateriality,
  MODE_WHERE,
  actionFamily,
  semanticBucket,
  clusterKey,
  pickPrimary,
  buildCluster,
  clusterPairs,
  // DB
  buildClusters,
  listClusters,
};
