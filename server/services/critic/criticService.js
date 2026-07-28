'use strict';

// Слой critic — третий шаг новой архитектуры анализа ТЗ (поверх draft_issues).
// Решает, увидит ли инженер замечание по умолчанию. Работает В ДВА ЭТАПА:
//
//   1. ОЦЕНКА МАТЕРИАЛЬНОСТИ (criticScoring.js, чистые функции) — критерии
//      компании дают impact_level (цена / срок / оплата / договор /
//      ответственность / объём) и evidence_level (структура находки: привязка к
//      тексту ТЗ, обоснование, число независимых сигналов). criticality агента и
//      confidence модели в расчёт НЕ входят — это легаси-поля сортировки
//      (score / display_priority).
//
//   2. PRECISION-КРИТИК (critic/precision/) — НЕЗАВИСИМАЯ проверка перед
//      публикацией, у которой последнее слово:
//        • уровень 1 — детерминированные жёсткие фильтры (редактура, повтор,
//          нет последствия, пробел покрытия ВОР, расширение объёма);
//        • уровень 2 — отдельная LLM-проверка ТОЛЬКО спорных, с установкой
//          «искать основания НЕ показывать».
//      Исход (publish_critical | publish_working | hide_informational |
//      reject_invalid) ложится в critic_outcome и превращается в verdict
//      (mergePrecisionDecision). Сбой критика НЕ публикует спорные medium/low:
//      они получают verdict='verify' — полка «На проверку».
//
// Ничего не удаляется: suppress и verify остаются в БД с причиной
// (suppression_reason / critic_assessment) и видны в режимах «На проверку»/«Все».
//
// ПАРАЛЛЕЛЬНЫЙ слой: не трогает issues / review / export / draft_issues.
// Сигналы-источники подтягиваются для доступа к criticality / risk_category /
// оценке материальности агента (их нет в самой draft_issue).

const db = require('../../db/connection');
const { newId, nowIso } = require('../../utils/ids');
const analysisRuns = require('../analysisRuns/analysisRunsService');
const materiality = require('../review/materiality');
const precision = require('./precision');
const {
  CRITERIA,
  impactFromWeight,
  deterministicFlags,
  evaluateDraft,
  reviewDrafts,
} = require('./criticScoring');

function safeParse(s, fallback) {
  if (!s) return fallback;
  try { const v = JSON.parse(s); return v == null ? fallback : v; } catch (_e) { return fallback; }
}

// --- Свод с precision-критиком ----------------------------------------------
//
// Решение precision-критика (publish_critical | publish_working |
// hide_informational | reject_invalid | null) — ПОСЛЕДНЕЕ слово о публикации.
// Оценка материальности остаётся входом критика и сохраняется в строке как
// легаси-поля, но verdict/impact/evidence/причины перезаписываются картой
// критика: у одного замечания должен быть ОДИН вердикт, а не два спорящих.
//
// Отображение исходов на модель материальности (services/review/materiality.js):
//   publish_critical / publish_working → verdict 'publish'
//   hide_informational / reject_invalid → verdict 'suppress'
//   null (критик не решил)             → verdict 'verify' (полка «На проверку»)

// Каналы критика → измерения материальности (payment сохраняем из базовой
// оценки: критик им не оперирует, а в выгрузках и UI он уже используется).
const CHANNEL_TO_DIMENSION = {
  cost_impact: 'price',
  scope_impact: 'scope',
  schedule_impact: 'schedule',
  contract_impact: 'contract',
  responsibility_impact: 'responsibility',
};

function dimensionsFromAssessment(assessment, fallbackDimensions = []) {
  const dims = [];
  for (const [channel, dim] of Object.entries(CHANNEL_TO_DIMENSION)) {
    if (assessment[channel] && assessment[channel] !== 'none') dims.push(dim);
  }
  // payment критик отдельно не оценивает — переносим из базовой оценки.
  if ((fallbackDimensions || []).includes('payment')) dims.push('payment');
  return materiality.mergeDimensions(dims);
}

function mergePrecisionDecision(review, decision, draft = {}) {
  if (!decision) return review;
  const a = decision.assessment;
  const published = precision.isPublished(decision.outcome);
  const verdict = decision.outcome == null ? 'verify' : (published ? 'publish' : 'suppress');

  // impact/evidence берём из карты критика: business_consequence и
  // evidence_strength — те же шкалы, что impact_level и evidence_level
  // (evidence 'none' в модели материальности отдельного уровня не имеет — это weak).
  const impact_level = materiality.normalizeImpactLevel(a.business_consequence, 'none');
  const evidence_level = materiality.normalizeEvidenceLevel(
    a.evidence_strength === 'none' ? 'weak' : a.evidence_strength,
    'weak',
  );
  const impact_dimensions = dimensionsFromAssessment(a, review.impact_dimensions);
  const required_action = materiality.resolveRequiredAction({
    verdict,
    suggestedAction: draft.suggested_action,
    dimensions: impact_dimensions,
  });

  const against = (decision.reasons_against || []).filter(Boolean);
  const againstText = against.length ? ` Доводы против: ${against.join('; ')}.` : '';

  return {
    ...review,
    impact_level,
    evidence_level,
    verdict,
    impact_dimensions,
    publication_reason: published ? `${decision.reason}${againstText}` : null,
    suppression_reason: verdict === 'suppress' ? decision.reason : null,
    required_action,
    show_to_engineer: published,
    critic_comment: `${decision.reason}${published ? againstText : ''}`,
    // Полная карта критика — в БД (прозрачность: видно КАЖДОЕ из 9 измерений и
    // по какому правилу принято решение).
    critic_outcome: decision.outcome,
    critic_source: decision.source,
    critic_rule: decision.rule,
    critic_assessment: {
      ...a,
      reasons_against: against,
      rule: decision.rule,
      source: decision.source,
    },
  };
}

// --- DB-обвязка -------------------------------------------------------------

function flattenSignal(row) {
  const p = safeParse(row.signal_payload_json, {});
  return {
    id: row.id,
    problem_type: p.problem_type || null,
    risk_category: p.risk_category || null,
    criticality: p.criticality || 'medium',
    // Оценка материальности от агента стадии (может отсутствовать: старый сигнал
    // или backfill из issues — тогда всё считает сервер).
    evidence_level: materiality.normalizeEvidenceLevel(p.evidence_level, null),
    impact_dimensions: materiality.normalizeDimensions(p.impact_dimensions),
    materiality_flags: materiality.normalizeSuppressionFlags(p.materiality_flags),
  };
}

// Главная функция: оценить все draft_issues тендера и записать issue_reviews
// (идемпотентно — перезапись прежнего набора для этого тендера).
// runId — прогон-КАНДИДАТ. Без него слой собирается в НОВЫЙ кандидат (указатель не
// двигается): одиночный build не имеет права переписать действующий снимок.
// options — настройки precision-критика (llmEnabled / batchSize / maxItems / model).
// По умолчанию берутся из окружения: LLM-уровень включён, если настроен ключ
// модели и PRECISION_CRITIC ≠ 0.
async function buildIssueReviews(tenderId, runId, options = {}) {
  const rid = runId || await analysisRuns.beginCandidateRun(tenderId, { reason: 'critic.build' });
  // draft_issues СНИМКА (этого прогона), не все по тендеру.
  const drafts = await db.queryAll(
    `SELECT * FROM draft_issues WHERE tender_id = ? AND analysis_run_id = ?
      ORDER BY paragraph_index ASC NULLS LAST, created_at ASC`,
    tenderId, rid,
  );
  // Сигналы актуальных stage-прогонов (тот же согласованный набор, что и у draft_issues).
  const stageRunIds = await analysisRuns.getActiveStageRunIds(tenderId);
  const sigRows = stageRunIds.length
    ? await db.queryAll(
      `SELECT * FROM analysis_signals WHERE tender_id = ? AND analysis_run_id IN (${stageRunIds.map(() => '?').join(', ')})`,
      tenderId, ...stageRunIds,
    )
    : [];
  const signalsById = new Map(sigRows.map((r) => [r.id, flattenSignal(r)]));

  // Уровень оценки материальности (детерминированный) — ВХОД precision-критика.
  const base = reviewDrafts(drafts, signalsById);

  // Precision-критик: жёсткие фильтры + LLM-проверка спорных. Его решение —
  // последнее слово о публикации. Сбой LLM не роняет сборку и НЕ публикует
  // спорные medium/low (см. precision/index.js, fail-closed).
  const { decisions, summary: precisionSummary } = await precision.runPrecisionCritic(base, options);
  const scored = base.map(({ draft, review }) => ({
    draft,
    review: mergePrecisionDecision(review, decisions.get(draft.id), draft),
  }));

  await db.transaction(async (tx) => {
    // Страж неизменяемости снимка (см. analysisRuns.assertRunWritable).
    await analysisRuns.assertRunWritable(tenderId, rid, { kind: 'pipeline' }, tx);
    await tx.queryRun(`DELETE FROM issue_reviews WHERE tender_id = ? AND analysis_run_id = ?`, tenderId, rid);
    const createdAt = nowIso();
    for (const { draft, review } of scored) {
      await tx.queryRun(
        `INSERT INTO issue_reviews (
           id, tender_id, analysis_run_id, draft_issue_id, business_impact, price_impact, schedule_impact,
           contract_impact, responsibility_impact, display_priority, show_to_engineer,
           critic_comment, criteria_json, score, created_at,
           impact_level, evidence_level, verdict, impact_dimensions,
           publication_reason, suppression_reason, required_action,
           critic_outcome, critic_source, critic_assessment
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId(), tenderId, rid, draft.id,
        review.business_impact, review.price_impact, review.schedule_impact,
        review.contract_impact, review.responsibility_impact, review.display_priority,
        review.show_to_engineer ? 1 : 0,
        review.critic_comment, JSON.stringify(review.criteria), review.score, createdAt,
        review.impact_level, review.evidence_level, review.verdict,
        JSON.stringify(review.impact_dimensions || []),
        review.publication_reason, review.suppression_reason, review.required_action,
        review.critic_outcome || null, review.critic_source || null,
        review.critic_assessment ? JSON.stringify(review.critic_assessment) : null,
      );
    }
  });

  const byPriority = scored.reduce((acc, { review }) => {
    acc[review.display_priority] = (acc[review.display_priority] || 0) + 1;
    return acc;
  }, {});
  const hidden = scored.filter(({ review }) => !review.show_to_engineer).length;
  const count = (predicate) => scored.filter(({ review }) => predicate(review)).length;

  return {
    summary: {
      run_id: rid,
      draft_issues: drafts.length,
      reviewed: scored.length,
      shown: scored.length - hidden,
      hidden,
      by_priority: byPriority,
      // Новая модель: сколько замечаний опубликовано / ушло на проверку / скрыто.
      by_verdict: scored.reduce((acc, { review }) => {
        acc[review.verdict] = (acc[review.verdict] || 0) + 1;
        return acc;
      }, {}),
      by_impact: scored.reduce((acc, { review }) => {
        acc[review.impact_level] = (acc[review.impact_level] || 0) + 1;
        return acc;
      }, {}),
      by_evidence: scored.reduce((acc, { review }) => {
        acc[review.evidence_level] = (acc[review.evidence_level] || 0) + 1;
        return acc;
      }, {}),
      published: count((r) => r.verdict === 'publish'),
      to_verify: count((r) => r.verdict === 'verify'),
      suppressed: count((r) => r.verdict === 'suppress'),
      // Precision-критик: сколько решено правилами, сколько проверено моделью,
      // сколько осталось нерешённым (и почему). Ничего не урезается молча.
      precision: precisionSummary,
      by_outcome: scored.reduce((acc, { review }) => {
        const key = review.critic_outcome || 'unresolved';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {}),
    },
  };
}

// Режимы отображения для UI-фильтров (новая модель — по вердикту):
//   important — опубликованные с высоким влиянием (critical|high);
//   working   — опубликованные материальные замечания — ПО УМОЛЧАНИЮ;
//   verify    — требуют проверки (риск может быть существенным, доказательств мало);
//   full      — всё, включая скрытое (с причиной подавления).
// verdict IS NULL быть не должно (миграция заполняет старые строки), но если
// строка всё же без вердикта — она не попадёт в working/important (fail-closed:
// не публикуем неизвестное) и останется видимой в full.
const MODE_WHERE = {
  important: `AND r.verdict = 'publish' AND r.impact_level IN ('critical','high')`,
  working: `AND r.verdict = 'publish'`,
  verify: `AND r.verdict = 'verify'`,
  full: ``,
};

// runId (опц.) — читать КОНКРЕТНЫЙ прогон (свежесобранного кандидата на
// debug-странице). По умолчанию — актуальный снимок.
async function listIssueReviews(tenderId, mode = 'working', { runId = null } = {}) {
  const where = MODE_WHERE[mode] != null ? MODE_WHERE[mode] : MODE_WHERE.working;
  const rid = runId || await analysisRuns.getActivePipelineRunId(tenderId);
  if (!rid) return [];
  const rows = await db.queryAll(
    `SELECT r.*, d.tz_clause, d.source_fragment, d.problem_type, d.category,
            d.basis, d.suggested_action, d.confidence, d.paragraph_index
       FROM issue_reviews r
       JOIN draft_issues d ON d.id = r.draft_issue_id
      WHERE r.tender_id = ? AND r.analysis_run_id = ? ${where}
      ORDER BY d.paragraph_index ASC NULLS LAST, r.score DESC`,
    tenderId, rid,
  );
  return rows.map((r) => ({
    ...r,
    show_to_engineer: Number(r.show_to_engineer) === 1,
    criteria: safeParse(r.criteria_json, []),
    impact_dimensions: (() => {
      const v = safeParse(r.impact_dimensions, []);
      return Array.isArray(v) ? v : [];
    })(),
    critic_assessment: safeParse(r.critic_assessment, null),
  }));
}

module.exports = {
  // чистое ядро (офлайн-тесты/демо)
  CRITERIA,
  MODE_WHERE,
  impactFromWeight,
  deterministicFlags,
  evaluateDraft,
  reviewDrafts,
  mergePrecisionDecision,
  dimensionsFromAssessment,
  // precision-критик (два уровня) — реэкспорт для тестов и debug-страниц
  precision,
  // DB
  buildIssueReviews,
  listIssueReviews,
};
