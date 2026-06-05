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
//                                     (remove / edit / note).
// Разные по смыслу проблемы в одном пункте (открытый объём ≠ риск оплаты) дают
// РАЗНЫЕ кластеры: у каждого свои cluster_items, каждый сохраняет своё основание.
//
// ПАРАЛЛЕЛЬНЫЙ слой: не трогает issues / review / export / draft_issues / critic.
// Группировка/слияние — чистые функции (тестируются без БД), как в
// review/consolidation.js и unifiedAnalysis.

const db = require('../../db/connection');
const { newId, nowIso } = require('../../utils/ids');

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

// Семейство действия: пересекающиеся действия считаются одним.
function actionFamily(draft) {
  const a = normalize(draft.suggested_action);
  if (a === 'delete' || a === 'remove_from_scope') return 'remove';
  if (a === 'edit') return 'edit';
  return 'note'; // accept / comment / пусто
}

// Смысловой ключ: измерение значимости + семейство действия. Разделяет
// «открытый объём» (price/responsibility + edit/remove) и «риск оплаты»
// (contract + note/edit) даже в одном пункте ТЗ.
function semanticBucket(draft, review) {
  return `${dominantDimension(review)}|${actionFamily(draft)}`;
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

  // Кластер показываем, если значим ХОТЯ БЫ один элемент (иначе всё малозначимо).
  const show_to_engineer = pairs.some((p) => p.review && p.review.show_to_engineer);

  const tz_clause = pairs.map((p) => p.draft.tz_clause).find(Boolean) || null;
  const cluster_title = `${DIM_LABEL[dim] || DIM_LABEL.general}${tz_clause ? ` — ${tz_clause}` : ''}`;

  const itemsSorted = [...pairs].sort(
    (a, b) => critOf(b) - critOf(a) || scoreOf(b) - scoreOf(a),
  );

  return {
    id: newId(),
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

// Грузит draft_issues тендера вместе с вердиктом critic (LEFT JOIN — кластеризуем
// даже без прогона critic: тогда review пуст и сработает дефолтный bucket).
async function loadPairs(tenderId) {
  const rows = await db.queryAll(
    `SELECT d.*,
            r.display_priority, r.show_to_engineer, r.score,
            r.price_impact, r.schedule_impact, r.contract_impact, r.responsibility_impact
       FROM draft_issues d
       LEFT JOIN issue_reviews r ON r.draft_issue_id = d.id
      WHERE d.tender_id = ?
      ORDER BY d.paragraph_index ASC NULLS LAST, d.created_at ASC`,
    tenderId,
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
    } : null,
  }));
}

// Главная функция: собрать кластеры тендера и сохранить (idempotent — перезапись
// прежнего набора). Возвращает summary.
async function buildClusters(tenderId) {
  const pairs = await loadPairs(tenderId);
  const clusters = clusterPairs(pairs, tenderId);

  await db.transaction(async (tx) => {
    await tx.queryRun(`DELETE FROM issue_clusters WHERE tender_id = ?`, tenderId);
    const createdAt = nowIso();
    for (const c of clusters) {
      await tx.queryRun(
        `INSERT INTO issue_clusters (
           id, tender_id, tz_clause, cluster_title, merged_basis, merged_recommendation,
           overall_criticality, show_to_engineer, final_problem_type,
           semantic_bucket, item_count, paragraph_index, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        c.id, c.tender_id, c.tz_clause, c.cluster_title, c.merged_basis, c.merged_recommendation,
        c.overall_criticality, c.show_to_engineer ? 1 : 0, c.final_problem_type,
        c.semantic_bucket, c.item_count, c.paragraph_index, createdAt,
      );
      for (const it of c.items) {
        await tx.queryRun(
          `INSERT INTO issue_cluster_items (id, cluster_id, draft_issue_id, item_role, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          newId(), c.id, it.draft_issue_id, it.item_role, createdAt,
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
      draft_issues: pairs.length,
      clusters: clusters.length,
      multi_item: clusters.filter((c) => c.item_count > 1).length,
      shown: clusters.filter((c) => c.show_to_engineer).length,
      hidden: clusters.filter((c) => !c.show_to_engineer).length,
      by_criticality: byCriticality,
    },
  };
}

// Режимы показа (как в critic): important — critical|high; working — show_to_engineer=1;
// full — всё.
const MODE_WHERE = {
  important: `AND c.overall_criticality IN ('critical','high')`,
  working: `AND c.show_to_engineer = 1`,
  full: ``,
};

// Читает кластеры + их элементы (draft_issues) одним проходом.
async function listClusters(tenderId, mode = 'working') {
  const where = MODE_WHERE[mode] != null ? MODE_WHERE[mode] : MODE_WHERE.working;
  const clusters = await db.queryAll(
    `SELECT * FROM issue_clusters c
      WHERE c.tender_id = ? ${where}
      ORDER BY c.paragraph_index ASC NULLS LAST, c.created_at ASC`,
    tenderId,
  );
  if (!clusters.length) return [];

  const ids = clusters.map((c) => c.id);
  const placeholders = ids.map(() => '?').join(', ');
  const itemRows = await db.queryAll(
    `SELECT ci.cluster_id, ci.item_role,
            d.id AS draft_issue_id, d.category, d.problem_type, d.source_fragment,
            d.basis, d.suggested_action, d.confidence,
            r.display_priority, r.show_to_engineer
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
    });
  }

  return clusters.map((c) => ({
    ...c,
    show_to_engineer: Number(c.show_to_engineer) === 1,
    items: itemsByCluster.get(c.id) || [],
  }));
}

module.exports = {
  // чистое ядро (офлайн-тесты/демо)
  placeKey,
  dominantDimension,
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
