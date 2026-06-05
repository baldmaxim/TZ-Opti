'use strict';

// Слой critic — третий шаг новой архитектуры анализа ТЗ (поверх draft_issues).
//
// Задача: оценить значимость каждого draft_issue ДЛЯ ГЕНПОДРЯДЧИКА и решить,
// показывать ли его инженеру в основном потоке. Малозначимые замечания не
// удаляются — им проставляется show_to_engineer=0 (скрыты по умолчанию, но
// доступны в «Полном режиме»).
//
// ПАРАЛЛЕЛЬНЫЙ слой: не трогает issues / review / export / draft_issues.
// Скоринг — детерминированные чистые функции (тестируются без БД), как в
// review/consolidation.js и unifiedAnalysis. Сигналы-источники подтягиваются
// для доступа к criticality / risk_category (их нет в самой draft_issue).

const db = require('../../db/connection');
const { newId, nowIso } = require('../../utils/ids');

// --- Критерии значимости для генподрядчика ---------------------------------
// Каждый критерий: вес (вклад в суммарный балл) + к каким impact-измерениям
// относится. Срабатывание определяется по signal_type'ам группы, problem_type,
// risk_category сигналов-источников и по ключевым словам текста (basis +
// review_comment + фрагмент ТЗ + путь заголовков).

const DIM = {
  PRICE: 'price_impact',
  SCHEDULE: 'schedule_impact',
  CONTRACT: 'contract_impact',
  RESP: 'responsibility_impact',
};

// key, weight, dims[], label (для critic_comment), match(ctx)->bool
const CRITERIA = [
  {
    key: 'affects_calc', weight: 2, dims: [DIM.PRICE], label: 'влияет на расчёт',
    match: (c) => c.category.has('coverage')
      || c.problemTypes.has('не_учтено_в_кп') || c.problemTypes.has('не_учтено_в_вор') || c.problemTypes.has('не_в_обоих')
      || c.riskCategories.has('покрытие_расчёта')
      || /расч[её]т|объ[её]м работ|ведомост|\bвор\b/.test(c.text),
  },
  {
    key: 'affects_kp', weight: 2, dims: [DIM.PRICE], label: 'влияет на КП',
    match: (c) => c.problemTypes.has('qa_исключено_из_кп') || c.problemTypes.has('не_учтено_в_кп')
      || /\bкп\b|коммерческ|смет|расцен|стоимост|\bцен[аеуы]|удорожан/.test(c.text),
  },
  {
    key: 'affects_contract', weight: 3, dims: [DIM.CONTRACT], label: 'влияет на договор',
    match: (c) => c.category.has('condition')
      || c.problemTypes.has('условие_противоречит')
      || c.riskCategories.has('договорной') || c.riskCategories.has('существенные_условия')
      || /договор|контракт|существенн\w*\s+услови/.test(c.text),
  },
  {
    key: 'affects_schedule', weight: 2, dims: [DIM.SCHEDULE], label: 'влияет на график',
    match: (c) => c.riskCategories.has('график')
      || c.problemTypes.has('влияние_на_срок')
      || /\bсрок|график|календарн|поэтапн|очередност|задержк|просрочк/.test(c.text),
  },
  {
    key: 'expands_scope', weight: 3, dims: [DIM.PRICE, DIM.RESP], label: 'расширяет объём работ',
    match: (c) => c.riskCategories.has('объём_работ') || c.riskCategories.has('объём_и_обязательства')
      || /в полном объ[её]ме|необходим\w*\s+и\s+достаточн|любые работы|за сво[йи] сч[её]т|собственными силами|без дополнительн\w* оплат|весь комплекс|в том числе(?! не)/.test(c.text),
  },
  {
    key: 'new_obligation', weight: 3, dims: [DIM.RESP], label: 'создаёт новую обязанность ГП',
    match: (c) => c.riskCategories.has('объём_и_обязательства')
      || /обяз(ан|ательств|уется)|возлагается на подрядчик|подрядчик\w*\s+(должен|обеспечива|выполня)|за сч[её]т подрядчика|силами подрядчика/.test(c.text),
  },
  {
    key: 'strengthens_liability', weight: 3, dims: [DIM.RESP], label: 'усиливает ответственность/гарантию',
    match: (c) => c.riskCategories.has('юридические_формулировки')
      || /ответственност|гаранти|штраф|неустойк|\bпени\b|возмещ\w*\s+ущерб|компенсир|удержан/.test(c.text),
  },
  {
    key: 'contradicts_company', weight: 3, dims: [DIM.CONTRACT], label: 'противоречит условиям компании',
    match: (c) => c.problemTypes.has('условие_противоречит')
      || c.problemTypes.has('qa_противоречит_тз') || c.problemTypes.has('char_противоречит_тз')
      || /противореч/.test(c.text),
  },
  {
    key: 'not_confirmed_by_docs', weight: 1, dims: [DIM.PRICE], label: 'не подтверждается ПД/РД/ВОР',
    match: (c) => c.problemTypes.has('не_учтено_в_вор') || c.problemTypes.has('не_в_обоих')
      || c.problemTypes.has('qa_отсутствует_информация')
      || /отсутств\w*\s+(в\s+)?(вор|пд|рд)|нет в вор|не подтвержд|не отраж\w* в (вор|пд|рд)/.test(c.text),
  },
  {
    key: 'affects_acceptance', weight: 2, dims: [DIM.PRICE, DIM.CONTRACT], label: 'влияет на приёмку/оплату',
    match: (c) => /приёмк|приемк|оплат|\bакт\b|кс-?2|кс-?3|платёж|платеж|сдач[аи]|ввод в эксплуатац/.test(c.text),
  },
];

const CRIT_BONUS = { critical: 3, high: 2, medium: 1, low: 0 };

function levelFromScore(s) {
  if (s >= 5) return 'high';
  if (s >= 3) return 'medium';
  if (s > 0) return 'low';
  return 'none';
}

function safeParse(s, fallback) {
  if (!s) return fallback;
  try { const v = JSON.parse(s); return v == null ? fallback : v; } catch (_e) { return fallback; }
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
  for (const s of signals || []) {
    if (s.problem_type) problemTypes.add(s.problem_type);
    if (s.risk_category) riskCategories.add(s.risk_category);
    if ((CRIT_BONUS[s.criticality] || 0) > (CRIT_BONUS[maxCrit] || 0)) maxCrit = s.criticality;
  }
  return { text, category, problemTypes, riskCategories, maxCriticality: maxCrit };
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

  // Скрываем только малозначимое: low уходит из основного потока.
  const show_to_engineer = display_priority !== 'low';

  const critic_comment = show_to_engineer
    ? `Значимо для ГП (${display_priority}): ${fired.map((cr) => cr.label).join('; ') || 'повышенная критичность источника'}.`
    : `Малозначимо для ГП: ${fired.length ? fired.map((cr) => cr.label).join('; ') : 'нет влияния на цену/срок/договор/ответственность'}. Скрыто из основного списка (доступно в полном режиме).`;

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
  };
}

// Главная функция: оценить все draft_issues тендера и записать issue_reviews
// (идемпотентно — перезапись прежнего набора для этого тендера).
async function buildIssueReviews(tenderId) {
  const drafts = await db.queryAll(
    `SELECT * FROM draft_issues WHERE tender_id = ? ORDER BY paragraph_index ASC NULLS LAST, created_at ASC`,
    tenderId,
  );
  const sigRows = await db.queryAll('SELECT * FROM analysis_signals WHERE tender_id = ?', tenderId);
  const signalsById = new Map(sigRows.map((r) => [r.id, flattenSignal(r)]));

  const scored = reviewDrafts(drafts, signalsById);

  await db.transaction(async (tx) => {
    await tx.queryRun(`DELETE FROM issue_reviews WHERE tender_id = ?`, tenderId);
    const createdAt = nowIso();
    for (const { draft, review } of scored) {
      await tx.queryRun(
        `INSERT INTO issue_reviews (
           id, tender_id, draft_issue_id, business_impact, price_impact, schedule_impact,
           contract_impact, responsibility_impact, display_priority, show_to_engineer,
           critic_comment, criteria_json, score, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId(), tenderId, draft.id,
        review.business_impact, review.price_impact, review.schedule_impact,
        review.contract_impact, review.responsibility_impact, review.display_priority,
        review.show_to_engineer ? 1 : 0,
        review.critic_comment, JSON.stringify(review.criteria), review.score, createdAt,
      );
    }
  });

  const byPriority = scored.reduce((acc, { review }) => {
    acc[review.display_priority] = (acc[review.display_priority] || 0) + 1;
    return acc;
  }, {});
  const hidden = scored.filter(({ review }) => !review.show_to_engineer).length;

  return {
    summary: {
      draft_issues: drafts.length,
      reviewed: scored.length,
      shown: scored.length - hidden,
      hidden,
      by_priority: byPriority,
    },
  };
}

// Режимы отображения для UI-фильтров:
//   important — только важное (critical|high);
//   working   — рабочий режим (show_to_engineer=1, т.е. скрыт low) — по умолчанию;
//   full      — полный режим (всё, включая скрытое).
const MODE_WHERE = {
  important: `AND r.display_priority IN ('critical','high')`,
  working: `AND r.show_to_engineer = 1`,
  full: ``,
};

async function listIssueReviews(tenderId, mode = 'working') {
  const where = MODE_WHERE[mode] != null ? MODE_WHERE[mode] : MODE_WHERE.working;
  const rows = await db.queryAll(
    `SELECT r.*, d.tz_clause, d.source_fragment, d.problem_type, d.category,
            d.basis, d.suggested_action, d.confidence, d.paragraph_index
       FROM issue_reviews r
       JOIN draft_issues d ON d.id = r.draft_issue_id
      WHERE r.tender_id = ? ${where}
      ORDER BY d.paragraph_index ASC NULLS LAST, r.score DESC`,
    tenderId,
  );
  return rows.map((r) => ({
    ...r,
    show_to_engineer: Number(r.show_to_engineer) === 1,
    criteria: safeParse(r.criteria_json, []),
  }));
}

module.exports = {
  // чистое ядро (офлайн-тесты/демо)
  CRITERIA,
  evaluateDraft,
  reviewDrafts,
  // DB
  buildIssueReviews,
  listIssueReviews,
};
