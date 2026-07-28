'use strict';

// Слой critic — третий шаг новой архитектуры анализа ТЗ (поверх draft_issues).
//
// Задача: оценить МАТЕРИАЛЬНОСТЬ каждого draft_issue ДЛЯ ГЕНПОДРЯДЧИКА и решить,
// увидит ли его инженер по умолчанию. Здесь — АВТОРИТЕТНЫЙ вердикт конвейера:
//
//   impact_level   — считается ТОЛЬКО по материальным критериям компании (CRITERIA
//                    ниже: цена / срок / оплата / договор / ответственность / объём).
//                    criticality агента и confidence модели в расчёт НЕ входят
//                    (правило 4 модели материальности) — они остались легаси-полями
//                    сортировки (score / display_priority).
//   evidence_level — по структурным фактам находки (привязка к тексту ТЗ,
//                    обоснование, число независимых сигналов), а не по confidence.
//   verdict        — publish | verify | suppress по матрице impact × evidence
//                    (services/review/materiality.js, VERDICT_MATRIX).
//
// Ничего не удаляется: suppress и verify остаются в БД с причиной
// (suppression_reason / verdict_reason) и видны в режимах «На проверку» и «Все».
//
// ПАРАЛЛЕЛЬНЫЙ слой: не трогает issues / review / export / draft_issues.
// Скоринг — детерминированные чистые функции (тестируются без БД), как в
// review/consolidation.js и unifiedAnalysis. Сигналы-источники подтягиваются
// для доступа к criticality / risk_category / оценке материальности агента
// (их нет в самой draft_issue).

const db = require('../../db/connection');
const { newId, nowIso } = require('../../utils/ids');
const analysisRuns = require('../analysisRuns/analysisRunsService');
const materiality = require('../review/materiality');

// --- Критерии материальности для генподрядчика ------------------------------
// Каждый критерий: вес (вклад в суммарный балл влияния) + измерения влияния.
// Срабатывание определяется по signal_type'ам группы, problem_type, risk_category
// сигналов-источников и по ключевым словам текста (basis + review_comment +
// фрагмент ТЗ + путь заголовков).
//
// dims        — ЛЕГАСИ-измерения (колонки price_impact/schedule_impact/
//               contract_impact/responsibility_impact). Их читает clustering
//               (dominantDimension → semantic_bucket → cluster_key), поэтому
//               значения сохранены в точности как были: менять их = ломать
//               привязку решений инженера к кластерам.
// dimensions  — НОВЫЕ измерения материальности (materiality.IMPACT_DIMENSIONS,
//               в т.ч. payment и scope, которых в легаси-четвёрке не было).
//               Идут в issue_reviews.impact_dimensions и в required_action.

const DIM = {
  PRICE: 'price_impact',
  SCHEDULE: 'schedule_impact',
  CONTRACT: 'contract_impact',
  RESP: 'responsibility_impact',
};

// Граница слова для РУССКОГО текста. `\b` в JS опирается на ASCII-класс \w, в
// который кириллица не входит: между пробелом и «с» перехода \w↔не-\w нет,
// поэтому /\bсрок/ и /\bвор\b/ на русском тексте не срабатывали НИКОГДА —
// критерии «влияет на график», «нет в ВОР», «влияет на КП» (по словам вор/кп/
// цена/акт/пени) молчали. Раньше это лишь занижало score, теперь от веса
// критериев зависит публикация замечания, поэтому границу задаём lookaround'ами
// по буквенно-цифровому классу с кириллицей. Смысл прежний: «вор» не должно
// ловиться внутри «воровство», «акт» — внутри «фактически».
const LB = '(?<![а-яёa-z0-9])'; // левая граница слова
const RB = '(?![а-яёa-z0-9])'; // правая граница слова

// Слова, для которых граница обязательна (иначе ложные срабатывания внутри
// других слов: «вор» в «воровство», «акт» в «фактически»).
const RE_VOR = new RegExp(`${LB}вор${RB}`);
const RE_KP = new RegExp(`${LB}кп${RB}`);
const RE_PRICE_WORD = new RegExp(`${LB}цен[аеуы]`);
const RE_TERM = new RegExp(`${LB}срок`);
const RE_ACT = new RegExp(`${LB}акт${RB}`);
const RE_PENALTY = new RegExp(`${LB}пени${RB}`);

// key, weight, dims[] (легаси), dimensions[] (новые), label, match(ctx)->bool
const CRITERIA = [
  {
    key: 'affects_calc', weight: 2, dims: [DIM.PRICE], dimensions: ['price'], label: 'влияет на расчёт',
    match: (c) => c.category.has('coverage')
      || c.problemTypes.has('не_учтено_в_кп') || c.problemTypes.has('не_учтено_в_вор') || c.problemTypes.has('не_в_обоих')
      || c.riskCategories.has('покрытие_расчёта')
      || /расч[её]т|объ[её]м работ|ведомост/.test(c.text)
      || RE_VOR.test(c.text),
  },
  {
    key: 'affects_kp', weight: 2, dims: [DIM.PRICE], dimensions: ['price'], label: 'влияет на КП',
    // не_в_обоих = работы нет ни в чек-листе, ни в ВОР → в КП её тоже нет:
    // самый дорогой вид пробела покрытия обязан давать материальное влияние,
    // а не «нет в ВОР» весом 1.
    match: (c) => c.problemTypes.has('qa_исключено_из_кп') || c.problemTypes.has('не_учтено_в_кп')
      || c.problemTypes.has('не_в_обоих')
      || /коммерческ|смет|расцен|стоимост|удорожан/.test(c.text)
      || RE_KP.test(c.text) || RE_PRICE_WORD.test(c.text),
  },
  {
    key: 'affects_contract', weight: 3, dims: [DIM.CONTRACT], dimensions: ['contract'], label: 'влияет на договор',
    match: (c) => c.category.has('condition')
      || c.problemTypes.has('условие_противоречит')
      || c.riskCategories.has('договорной') || c.riskCategories.has('существенные_условия')
      || /договор|контракт|существенн\w*\s+услови/.test(c.text),
  },
  {
    key: 'affects_schedule', weight: 2, dims: [DIM.SCHEDULE], dimensions: ['schedule'], label: 'влияет на график',
    match: (c) => c.riskCategories.has('график')
      || c.problemTypes.has('влияние_на_срок')
      || /график|календарн|поэтапн|очередност|задержк|просрочк/.test(c.text)
      || RE_TERM.test(c.text),
  },
  {
    key: 'expands_scope', weight: 3, dims: [DIM.PRICE, DIM.RESP], dimensions: ['scope', 'price'], label: 'расширяет объём работ',
    match: (c) => c.riskCategories.has('объём_работ') || c.riskCategories.has('объём_и_обязательства')
      || /в полном объ[её]ме|необходим\w*\s+и\s+достаточн|любые работы|за сво[йи] сч[её]т|собственными силами|без дополнительн\w* оплат|весь комплекс|в том числе(?! не)/.test(c.text),
  },
  {
    key: 'new_obligation', weight: 3, dims: [DIM.RESP], dimensions: ['responsibility', 'scope'], label: 'создаёт новую обязанность ГП',
    match: (c) => c.riskCategories.has('объём_и_обязательства')
      || /обяз(ан|ательств|уется)|возлагается на подрядчик|подрядчик\w*\s+(должен|обеспечива|выполня)|за сч[её]т подрядчика|силами подрядчика/.test(c.text),
  },
  {
    key: 'strengthens_liability', weight: 3, dims: [DIM.RESP], dimensions: ['responsibility', 'contract'], label: 'усиливает ответственность/гарантию',
    match: (c) => c.riskCategories.has('юридические_формулировки')
      || /ответственност|гаранти|штраф|неустойк|возмещ\w*\s+ущерб|компенсир|удержан/.test(c.text)
      || RE_PENALTY.test(c.text),
  },
  {
    key: 'contradicts_company', weight: 3, dims: [DIM.CONTRACT], dimensions: ['contract'], label: 'противоречит условиям компании',
    match: (c) => c.problemTypes.has('условие_противоречит')
      || c.problemTypes.has('qa_противоречит_тз') || c.problemTypes.has('char_противоречит_тз')
      || /противореч/.test(c.text),
  },
  {
    key: 'not_confirmed_by_docs', weight: 1, dims: [DIM.PRICE], dimensions: ['price'], label: 'не подтверждается ПД/РД/ВОР',
    match: (c) => c.problemTypes.has('не_учтено_в_вор') || c.problemTypes.has('не_в_обоих')
      || c.problemTypes.has('qa_отсутствует_информация')
      || /отсутств\w*\s+(в\s+)?(вор|пд|рд)|нет в вор|не подтвержд|не отраж\w* в (вор|пд|рд)/.test(c.text),
  },
  {
    key: 'affects_acceptance', weight: 2, dims: [DIM.PRICE, DIM.CONTRACT], dimensions: ['payment', 'price'], label: 'влияет на приёмку/оплату',
    match: (c) => /приёмк|приемк|оплат|кс-?2|кс-?3|платёж|платеж|сдач[аи]|ввод в эксплуатац/.test(c.text)
      || RE_ACT.test(c.text),
  },
];

const CRIT_BONUS = { critical: 3, high: 2, medium: 1, low: 0 };

function levelFromScore(s) {
  if (s >= 5) return 'high';
  if (s >= 3) return 'medium';
  if (s > 0) return 'low';
  return 'none';
}

// Уровень ВЛИЯНИЯ из суммарного веса сработавших материальных критериев.
// Калибровка (веса критериев см. CRITERIA):
//   ≥6 — критическое: договорное противоречие + ответственность, расширение
//        объёма + новая обязанность ГП;
//   ≥3 — высокое: пробел покрытия расчёта (расчёт+КП), усиление ответственности,
//        противоречие условиям компании;
//    2 — умеренное: одиночный критерий среднего веса (срок, приёмка, расчёт);
//    1 — низкое: единственный слабый признак («нет в ВОР» сам по себе);
//    0 — нет материального влияния.
// Правило 5: low и none не публикуются НИКОГДА — даже при strong evidence.
function impactFromWeight(w) {
  if (w >= 6) return 'critical';
  if (w >= 3) return 'high';
  if (w >= 2) return 'medium';
  if (w > 0) return 'low';
  return 'none';
}

function safeParse(s, fallback) {
  if (!s) return fallback;
  try { const v = JSON.parse(s); return v == null ? fallback : v; } catch (_e) { return fallback; }
}

// --- Детерминированное распознавание НЕматериального ------------------------
// Правило 3 модели материальности: редактура и стандартные требования не
// публикуются. Флаги здесь выводятся из текста и применяются ТОЛЬКО к находкам
// без материального веса — они уточняют ПРИЧИНУ («редактура» вместо общего «нет
// влияния»), но не могут скрыть замечание, за которым стоит материальный
// критерий. Скрыть материальное может лишь явный флаг агента, и тогда вердикт
// становится verify (см. contested в materiality.resolveVerdict).
const EDITORIAL_RE =
  /опечатк|орфограф|пунктуац|грамматич|стилистич|редакционн|нумерац|шрифт|форматирован|оформлени\w*\s+(текст|документ|таблиц)/;
const STANDARD_REQUIREMENT_RE =
  /в соответствии с\s+(снип|гост|сп\b|сн\b|нормативн)|согласно\s+(снип|гост|нормативн)|требовани\w*\s+нормативн|стандартн\w*\s+требовани|обычн\w*\s+практик/;

function deterministicFlags(ctx) {
  const flags = [];
  if (EDITORIAL_RE.test(ctx.text)) flags.push('editorial');
  if (STANDARD_REQUIREMENT_RE.test(ctx.text)) flags.push('standard_requirement');
  return flags;
}

// Готовит контекст оценки из draft_issue + его сигналов-источников.
function buildContext(draft, signals) {
  const text = [draft.basis, draft.review_comment, draft.source_fragment, draft.tz_clause]
    .filter(Boolean).join(' \n ').toLowerCase();
  const category = new Set(String(draft.category || '').split('+').filter(Boolean));
  const problemTypes = new Set();
  const riskCategories = new Set();
  let maxCrit = 'low';
  if (draft.problem_type) problemTypes.add(draft.problem_type);
  const declaredEvidence = [];
  const declaredDimensions = [];
  const declaredFlags = [];
  for (const s of signals || []) {
    if (s.problem_type) problemTypes.add(s.problem_type);
    if (s.risk_category) riskCategories.add(s.risk_category);
    if ((CRIT_BONUS[s.criticality] || 0) > (CRIT_BONUS[maxCrit] || 0)) maxCrit = s.criticality;
    if (s.evidence_level) declaredEvidence.push(s.evidence_level);
    if (Array.isArray(s.impact_dimensions) && s.impact_dimensions.length) {
      declaredDimensions.push(...s.impact_dimensions);
    }
    if (Array.isArray(s.materiality_flags) && s.materiality_flags.length) {
      declaredFlags.push(...s.materiality_flags);
    }
  }
  // Флаг «не материально» учитываем, только если так сказали ВСЕ сигналы группы:
  // один материальный сигнал сохраняет замечание живым.
  const list = signals || [];
  const allFlagged = list.length > 0
    && list.every((s) => Array.isArray(s.materiality_flags) && s.materiality_flags.length > 0);

  // Число НЕЗАВИСИМЫХ подтверждений: разные типы сигналов (стадии видят ТЗ
  // по-разному), а не количество строк одной стадии.
  const corroboration = Math.max(category.size, 1);

  return {
    text,
    category,
    problemTypes,
    riskCategories,
    maxCriticality: maxCrit,
    corroboration,
    // «Мнение агента»: доказательность и измерения (impact_level агента сюда НЕ
    // попадает — уровень влияния считают критерии компании, правило 4).
    declaredEvidence: declaredEvidence.length ? materiality.maxEvidence(declaredEvidence) : null,
    declaredDimensions: materiality.normalizeDimensions(declaredDimensions),
    declaredFlags: allFlagged ? materiality.normalizeSuppressionFlags(declaredFlags) : [],
  };
}

// Чистое ядро: draft_issue + сигналы-источники -> вердикт critic.
function evaluateDraft(draft, signals) {
  const ctx = buildContext(draft, signals);

  const fired = CRITERIA.filter((cr) => cr.match(ctx));
  const firedKeys = fired.map((cr) => cr.key);

  // Суммарный балл значимости: веса критериев + бонус за критичность сигналов +
  // небольшой бонус за высокую уверенность сборки.
  let score = fired.reduce((acc, cr) => acc + cr.weight, 0);
  score += CRIT_BONUS[ctx.maxCriticality] || 0;
  if (typeof draft.confidence === 'number' && draft.confidence >= 0.9) score += 1;

  // Поддименсии: сумма весов сработавших критериев, относящихся к измерению.
  const dimScore = { [DIM.PRICE]: 0, [DIM.SCHEDULE]: 0, [DIM.CONTRACT]: 0, [DIM.RESP]: 0 };
  for (const cr of fired) for (const d of cr.dims) dimScore[d] += cr.weight;
  const critBump = ctx.maxCriticality === 'critical' ? 2 : ctx.maxCriticality === 'high' ? 1 : 0;

  const price_impact = levelFromScore(dimScore[DIM.PRICE] ? dimScore[DIM.PRICE] + critBump : 0);
  const schedule_impact = levelFromScore(dimScore[DIM.SCHEDULE] ? dimScore[DIM.SCHEDULE] + critBump : 0);
  const contract_impact = levelFromScore(dimScore[DIM.CONTRACT] ? dimScore[DIM.CONTRACT] + critBump : 0);
  const responsibility_impact = levelFromScore(dimScore[DIM.RESP] ? dimScore[DIM.RESP] + critBump : 0);

  // Приоритет показа — бакеты по суммарному баллу.
  let display_priority;
  if (score >= 9) display_priority = 'critical';
  else if (score >= 6) display_priority = 'high';
  else if (score >= 3) display_priority = 'medium';
  else display_priority = 'low';

  // Общая значимость для бизнеса (none|low|medium|high) — компактная проекция.
  const business_impact = display_priority === 'critical' ? 'high'
    : display_priority === 'low' ? (score > 0 ? 'low' : 'none')
      : display_priority; // high|medium

  // --- Новая модель: impact × evidence → verdict -----------------------------
  //
  // materialWeight — сумма весов сработавших МАТЕРИАЛЬНЫХ критериев. В ней НЕТ
  // ни бонуса за criticality сигнала, ни бонуса за confidence сборки (правило 4):
  // иначе «агент уверен» снова подменяло бы «ГП дорого».
  const materialWeight = fired.reduce((acc, cr) => acc + cr.weight, 0);
  const impact_level = impactFromWeight(materialWeight);

  // Измерения: выведенные критериями + заявленные агентом (объединение).
  const impact_dimensions = materiality.mergeDimensions(
    fired.flatMap((cr) => cr.dimensions || []),
    ctx.declaredDimensions,
  );

  // Доказательность — по структуре находки; заявленное агентом может только
  // понизить (materiality.resolveEvidence, fail-closed).
  const anchored = draft.paragraph_index != null && Boolean(draft.source_fragment);
  const evidence_level = materiality.resolveEvidence({
    anchored,
    hasBasis: Boolean(draft.basis),
    corroboration: ctx.corroboration,
    declared: ctx.declaredEvidence,
  });

  // Флаги подавления: явные от агента (перебивают) + выведенные из текста
  // (уточняют причину у находок без материального веса).
  const declaredFlags = ctx.declaredFlags;
  const textFlags = materialWeight > 0 ? [] : deterministicFlags(ctx);
  const suppressionFlags = [...declaredFlags, ...textFlags];
  // Спор: агент назвал замечание нематериальным, а критерии компании дают
  // высокое влияние → не скрываем, отправляем инженеру на проверку.
  const contested = declaredFlags.length > 0
    && materiality.impactRank(impact_level) >= materiality.impactRank('high');

  const resolved = materiality.resolveVerdict({
    impactLevel: impact_level,
    evidenceLevel: evidence_level,
    dimensions: impact_dimensions,
    suppressionFlags,
    contested,
    note: fired.length ? `Критерии: ${fired.map((cr) => cr.label).join('; ')}.` : null,
  });
  const required_action = materiality.resolveRequiredAction({
    verdict: resolved.verdict,
    suggestedAction: draft.suggested_action,
    dimensions: resolved.impact_dimensions,
  });

  // Инженер по умолчанию видит ТОЛЬКО опубликованные (материальные) замечания.
  // verify и suppress не удаляются — они в режимах «На проверку» и «Все».
  const show_to_engineer = resolved.verdict === 'publish';

  const critic_comment = resolved.verdict_reason;

  return {
    business_impact,
    price_impact,
    schedule_impact,
    contract_impact,
    responsibility_impact,
    display_priority,
    show_to_engineer,
    critic_comment,
    criteria: firedKeys,
    score,
    // Новая модель оценки (авторитетная для публикации).
    impact_level: resolved.impact_level,
    evidence_level: resolved.evidence_level,
    verdict: resolved.verdict,
    impact_dimensions: resolved.impact_dimensions,
    publication_reason: resolved.publication_reason,
    suppression_reason: resolved.suppression_reason,
    required_action,
    material_weight: materialWeight,
  };
}

// Чистое ядро над набором: drafts[] + map(signalId->signal) -> вердикты[].
function reviewDrafts(drafts, signalsById) {
  return drafts.map((d) => {
    const ids = Array.isArray(d.created_from_signal_ids)
      ? d.created_from_signal_ids
      : safeParse(d.created_from_signal_ids, []);
    const signals = ids.map((id) => signalsById.get(id)).filter(Boolean);
    return { draft: d, review: evaluateDraft(d, signals) };
  });
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
async function buildIssueReviews(tenderId, runId) {
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

  const scored = reviewDrafts(drafts, signalsById);

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
           publication_reason, suppression_reason, required_action
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId(), tenderId, rid, draft.id,
        review.business_impact, review.price_impact, review.schedule_impact,
        review.contract_impact, review.responsibility_impact, review.display_priority,
        review.show_to_engineer ? 1 : 0,
        review.critic_comment, JSON.stringify(review.criteria), review.score, createdAt,
        review.impact_level, review.evidence_level, review.verdict,
        JSON.stringify(review.impact_dimensions || []),
        review.publication_reason, review.suppression_reason, review.required_action,
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
  // DB
  buildIssueReviews,
  listIssueReviews,
};
