'use strict';

// Покрытие существенных условий — ЧИСТОЕ ядро (без БД, LLM и express).
//
// Прежняя Стадия 3 видела только ПРЯМОЕ противоречие: «ТЗ говорит несовместимое
// с условием компании, вот цитата». Но для ГП отсутствие условия нередко
// опаснее неправильной формулировки: если в ТЗ и пакете нет порядка оформления
// доп. работ, индексации при переносе сроков или лимита ответственности —
// сослаться будет не на что, а риск останется. Поэтому у КАЖДОГО условия и
// каждой темы покрытия теперь есть СТАТУС ПОКРЫТИЯ, а «условие отсутствует» —
// полноценная находка без якоря в тексте (её доказательство — реестр условий и
// детерминированная сверка всех частей ТЗ, а не цитата).
//
// Разделение ролей:
//   агент (Стадия 3) выставляет: matches | contradicts | ambiguous | missing;
//   инженер (override) может дополнить знанием пакета: other_document |
//   check_contract | not_applicable | resolved_in_contract | risk_accepted
//   (и поменять действие). Находку «условие_отсутствует» гасит ТОЛЬКО
//   закрывающий статус (CLOSING_STATUSES) — примечание или check_contract
//   тему не закрывают, риск остаётся в реестре.

// Статусы покрытия (полный словарь — агентские + инженерские).
const COVERAGE_STATUSES = Object.freeze([
  'matches', //              соответствует условию компании
  'contradicts', //          противоречит (есть цитата — отдельная находка)
  'missing', //              тема не обнаружена ни в ТЗ, ни в приложениях
  'ambiguous', //            тема затронута, но сформулирована неоднозначно
  'other_document', //       есть только в другом документе пакета (инженер, закрывает)
  'check_contract', //       требует проверки проекта договора (инженер, НЕ закрывает)
  'not_applicable', //       неприменимо к данному тендеру (инженер, закрывает)
  'resolved_in_contract', // урегулировано в проекте договора (инженер, закрывает)
  'risk_accepted', //        риск принят компанией осознанно (инженер, закрывает)
]);

const AGENT_STATUSES = Object.freeze(['matches', 'contradicts', 'ambiguous', 'missing']);
const ENGINEER_ONLY_STATUSES = Object.freeze([
  'other_document', 'check_contract', 'not_applicable', 'resolved_in_contract', 'risk_accepted',
]);

// ЗАКРЫВАЮЩИЕ статусы: тема действительно решена — находка «условие_отсутствует»
// не эмитится. check_contract закрывающим НЕ является: это действие («надо
// проверить»), вопрос ещё открыт. Строка override без статуса (только note)
// тоже НЕ закрывает тему — примечание инженера не скрывает нерешённый риск.
const CLOSING_STATUSES = Object.freeze([
  'matches', 'other_document', 'not_applicable', 'resolved_in_contract', 'risk_accepted',
]);
const isClosingStatus = (status) => CLOSING_STATUSES.includes(status);
const isTopicClosedByOverride = (override) => Boolean(override && isClosingStatus(override.status));

// Правильное действие для отсутствующего условия — НЕ «удалить текст».
const RESOLUTIONS = Object.freeze([
  'ask_customer', //        запрос Заказчику
  'add_assumption', //      тендерное допущение
  'exclude_from_price', //  исключение из цены
  'kp_condition', //        условие коммерческого предложения
  'check_contract', //      пункт для проверки проекта договора
  'risk_reserve', //        резерв риска
  'none',
]);

// resolution → required_action модели материальности (review/materiality.js).
// Словарь REQUIRED_ACTIONS сознательно НЕ расширяется (он прошит в критика,
// кластеры и валидатор benchmark) — тонкая реакция хранится в матрице покрытия
// (resolution) и в тексте находки, а сюда идёт ближайшее существующее действие.
const RESOLUTION_TO_REQUIRED_ACTION = Object.freeze({
  ask_customer: 'ask_customer',
  add_assumption: 'add_assumption',
  exclude_from_price: 'exclude_scope',
  kp_condition: 'add_assumption',
  check_contract: 'ask_customer',
  risk_reserve: 'recalculate',
  none: 'none',
});

// resolution → suggested_action находки (analysis/actions.js). Текст ТЗ находка
// не правит — действия только «спросить / зафиксировать допущение». comment не
// используется: у каждой реакции есть конкретное действие (иначе фильтр
// not_actionable считал бы пробел «нечего делать» и прятал его).
const RESOLUTION_TO_SUGGESTED_ACTION = Object.freeze({
  ask_customer: 'clarify',
  add_assumption: 'assumption',
  exclude_from_price: 'assumption',
  kp_condition: 'assumption',
  check_contract: 'clarify',
  risk_reserve: 'assumption',
  none: 'comment',
});

// ТЕМЫ ПОКРЫТИЯ — договорные темы, отсутствие которых опасно для ГП, но которых
// нет в справочнике стандартных условий компании (у них нет «стандартного
// текста» — есть только вопрос «а сказано ли об этом хоть что-нибудь?»).
// desc идёт в промт агенту (что искать), resolution — действие по умолчанию
// для отсутствующей темы, dimensions — каналы влияния для материальности.
const COVERAGE_TOPICS = Object.freeze([
  { key: 'extra_works_order', name: 'Порядок оформления дополнительных работ', desc: 'как оформляются и оплачиваются работы сверх договора (доп. соглашение, наряд, акт)', resolution: 'check_contract', criticality: 'high', dimensions: ['price', 'contract'] },
  { key: 'rd_delay', name: 'Последствия задержки РД и исходных данных', desc: 'что происходит при несвоевременной выдаче рабочей документации и исходных данных Заказчиком', resolution: 'ask_customer', criticality: 'high', dimensions: ['schedule', 'responsibility'] },
  { key: 'term_extension', name: 'Продление срока по причинам Заказчика', desc: 'право ГП на продление срока при простоях/задержках по вине Заказчика', resolution: 'check_contract', criticality: 'high', dimensions: ['schedule', 'contract'] },
  { key: 'indexation_on_shift', name: 'Индексация при переносе сроков', desc: 'пересмотр цены при сдвиге сроков строительства не по вине ГП', resolution: 'kp_condition', criticality: 'high', dimensions: ['price', 'schedule'] },
  { key: 'ks2_docs_list', name: 'Закрытый перечень документов для КС-2 и оплаты', desc: 'исчерпывающий список документов, при предоставлении которых Заказчик обязан подписать КС-2 и оплатить', resolution: 'check_contract', criticality: 'high', dimensions: ['payment'] },
  { key: 'materials_approval_term', name: 'Сроки согласования материалов и образцов', desc: 'предельный срок ответа Заказчика на согласование материалов, образцов, паспортов', resolution: 'ask_customer', criticality: 'medium', dimensions: ['schedule'] },
  { key: 'front_handover', name: 'Порядок передачи фронта работ', desc: 'как и в какие сроки передаётся строительная готовность/фронт работ, акт передачи', resolution: 'ask_customer', criticality: 'high', dimensions: ['schedule', 'responsibility'] },
  { key: 'temp_works_payment', name: 'Оплата временных работ', desc: 'оплачиваются ли временные здания, сооружения, сети и дороги, и как', resolution: 'kp_condition', criticality: 'medium', dimensions: ['price'] },
  { key: 'unforeseen_conditions', name: 'Ответственность за непредвиденные условия', desc: 'кто несёт риск скрытых/непредвиденных условий площадки (грунты, коммуникации, находки)', resolution: 'risk_reserve', criticality: 'high', dimensions: ['price', 'responsibility'] },
  { key: 'liability_cap', name: 'Лимит совокупной ответственности', desc: 'ограничен ли совокупный размер неустоек и убытков ГП (например, % от цены договора)', resolution: 'check_contract', criticality: 'high', dimensions: ['responsibility', 'contract'] },
  { key: 'unilateral_setoff', name: 'Порядок одностороннего удержания штрафов', desc: 'может ли Заказчик удерживать штрафы из оплат в одностороннем порядке без суда/акта', resolution: 'check_contract', criticality: 'high', dimensions: ['payment', 'responsibility'] },
  { key: 'silent_acceptance', name: 'Приёмка работ по молчанию', desc: 'считаются ли работы принятыми, если Заказчик не ответил на КС-2/акт в срок', resolution: 'check_contract', criticality: 'high', dimensions: ['payment', 'contract'] },
  { key: 'stop_on_nonpayment', name: 'Остановка работ при неоплате', desc: 'право ГП приостановить работы при просрочке оплаты Заказчиком', resolution: 'check_contract', criticality: 'high', dimensions: ['payment', 'contract'] },
  { key: 'downtime_compensation', name: 'Компенсация простоев', desc: 'компенсируются ли простои техники и людей по причинам Заказчика', resolution: 'ask_customer', criticality: 'medium', dimensions: ['price', 'schedule'] },
  { key: 'volume_change_order', name: 'Порядок изменения объёмов', desc: 'как оформляется увеличение/уменьшение объёмов работ и пересчёт цены', resolution: 'check_contract', criticality: 'high', dimensions: ['price', 'scope'] },
  { key: 'documents_priority', name: 'Приоритет документов при противоречии', desc: 'какой документ пакета главнее при противоречии (договор, ТЗ, ПД, РД, ВОР, приложения)', resolution: 'ask_customer', criticality: 'high', dimensions: ['contract'] },
  { key: 'pnr_commissioning', name: 'Пусконаладка и ввод в эксплуатацию', desc: 'кто выполняет и оплачивает ПНР, испытания, комплексное опробование и сопровождение ввода (ЗОС, РВ)', resolution: 'ask_customer', criticality: 'high', dimensions: ['price', 'scope'] },
  { key: 'insurance_smr', name: 'Страхование СМР', desc: 'кто страхует строительно-монтажные риски и ответственность, за чей счёт, кто выгодоприобретатель', resolution: 'check_contract', criticality: 'medium', dimensions: ['price', 'contract'] },
  { key: 'termination_consequences', name: 'Последствия расторжения договора', desc: 'порядок расчётов при расторжении: оплата выполненного, заказанных материалов, мобилизации/демобилизации', resolution: 'check_contract', criticality: 'high', dimensions: ['payment', 'contract'] },
  { key: 'design_error_liability', name: 'Ответственность за ошибки ПД/РД', desc: 'кто отвечает за проектные решения, коллизии и пробелы документации и за чей счёт они устраняются', resolution: 'ask_customer', criticality: 'high', dimensions: ['price', 'responsibility'] },
  { key: 'customer_materials', name: 'Давальческие материалы и оборудование Заказчика', desc: 'порядок передачи, приёмки, хранения и ответственности за материалы/оборудование поставки Заказчика', resolution: 'ask_customer', criticality: 'medium', dimensions: ['responsibility', 'scope'] },
  { key: 'bim_data', name: 'Информационные модели и передача данных', desc: 'требования к BIM/ТИМ-модели и цифровым данным: состав, формат, кто ведёт и за чей счёт', resolution: 'kp_condition', criticality: 'medium', dimensions: ['price', 'scope'] },
  { key: 'confidentiality_ip', name: 'Конфиденциальность и права на документацию', desc: 'объём NDA и кому принадлежат права на РД, исполнительную документацию и разработки ГП', resolution: 'check_contract', criticality: 'low', dimensions: ['contract'] },
  { key: 'city_restrictions', name: 'Проектные и городские ограничения', desc: 'режим шумных работ, ограничения въезда/логистики, экологические и городские требования и их учёт в сроках/цене', resolution: 'ask_customer', criticality: 'medium', dimensions: ['schedule', 'price'] },
]);

// Статусы, которые агент выдаёт по ЧАСТИ ТЗ (русские — как в схеме стадии).
const PART_STATUS = Object.freeze({
  CONTRADICTS: 'противоречит',
  MATCHES: 'соответствует',
  AMBIGUOUS: 'неоднозначно',
});
// Легаси-значение прежней схемы — принимаем как «соответствует».
const PART_STATUS_ALIASES = Object.freeze({ 'отражено_корректно': PART_STATUS.MATCHES });

function normalizePartStatus(v) {
  const s = String(v || '').trim().toLowerCase();
  if (Object.values(PART_STATUS).includes(s)) return s;
  if (PART_STATUS_ALIASES[s]) return PART_STATUS_ALIASES[s];
  return null;
}

const topicKeyOfCondition = (idx) => `cond:${idx}`;
const topicKeyOfTopic = (key) => `topic:${key}`;

// Полный список тем покрытия тендера: условия компании + темы покрытия.
// conditions: [{ idx, name, text, comment, criticality }]
function buildTopicList(conditions) {
  const out = [];
  for (const c of conditions || []) {
    out.push({
      topic_key: topicKeyOfCondition(c.idx),
      kind: 'condition',
      name: c.name,
      standard_text: c.text || null,
      desc: c.comment || null,
      resolution: 'kp_condition',
      criticality: c.criticality || 'high',
      dimensions: ['contract'],
    });
  }
  for (const t of COVERAGE_TOPICS) {
    out.push({
      topic_key: topicKeyOfTopic(t.key),
      kind: 'topic',
      name: t.name,
      standard_text: null,
      desc: t.desc,
      resolution: t.resolution,
      criticality: t.criticality,
      dimensions: t.dimensions,
    });
  }
  return out;
}

// АГРЕГАЦИЯ ПО ЧАСТЯМ. «Отсутствует» можно утверждать только по ВСЕМУ
// документу: одна часть не вправе сказать «темы нет вовсе» — тема может быть в
// другой части. Поэтому каждая часть сообщает только то, что ВИДИТ
// (затронутые темы со статусом), а итог сводится детерминированно:
//   есть противоречие в любой части → contradicts;
//   иначе есть неоднозначность      → ambiguous;
//   иначе тема затронута            → matches;
//   не затронута НИ В ОДНОЙ части   → missing (пересечение, как «нет в ВОР»
//   у Стадии 1 — только по пересечению всех частей).
//
// topics — из buildTopicList; records — [{ name, status, fragment,
// section_path, segment }] (по всем частям). Возвращает Map topic_key → row.
function aggregateCoverage(topics, records) {
  const byName = new Map(topics.map((t) => [t.name.trim().toLowerCase(), t]));
  const acc = new Map(); // topic_key -> { statuses:Set, evidence:[] }
  for (const t of topics) acc.set(t.topic_key, { statuses: new Set(), evidence: [] });

  for (const r of records || []) {
    const topic = byName.get(String(r.name || '').trim().toLowerCase());
    const status = normalizePartStatus(r.status);
    if (!topic || !status) continue;
    const slot = acc.get(topic.topic_key);
    slot.statuses.add(status);
    slot.evidence.push({
      segment: r.segment ?? null,
      status,
      fragment: (r.fragment || '').trim() || null,
      section_path: (r.section_path || '').trim() || null,
    });
  }

  const out = new Map();
  for (const t of topics) {
    const slot = acc.get(t.topic_key);
    let status = 'missing';
    if (slot.statuses.has(PART_STATUS.CONTRADICTS)) status = 'contradicts';
    else if (slot.statuses.has(PART_STATUS.AMBIGUOUS)) status = 'ambiguous';
    else if (slot.statuses.has(PART_STATUS.MATCHES)) status = 'matches';
    out.set(t.topic_key, {
      topic_key: t.topic_key,
      kind: t.kind,
      name: t.name,
      status,
      evidence: slot.evidence,
      resolution: status === 'missing' ? t.resolution : null,
      criticality: t.criticality,
    });
  }
  return out;
}

// Отбор тем для находки «условие_отсутствует»: missing по агрегату И не закрыта
// ЯВНЫМ закрывающим статусом инженера. coverage — Map из aggregateCoverage,
// overrides — Map topic_key → строка override (coverageService.getOverrides).
// Примечание без статуса и открытые статусы (check_contract, missing, …)
// находку НЕ гасят — риск остаётся в реестре замечаний.
function selectMissingTopics(topics, coverage, overrides) {
  const emit = [];
  const suppressed = [];
  for (const t of topics || []) {
    const row = coverage.get(t.topic_key);
    if (!row || row.status !== 'missing') continue;
    if (isTopicClosedByOverride(overrides && overrides.get(t.topic_key))) suppressed.push(t);
    else emit.push(t);
  }
  return { emit, suppressed };
}

const CRIT_TO_IMPACT = Object.freeze({ critical: 'critical', high: 'high', medium: 'medium', low: 'low' });

// Находка «условие отсутствует» — БЕЗ якоря в ТЗ (fragment=null): её
// доказательство — реестр условий компании и сверка всех частей. Действие —
// правильная реакция (запрос/допущение/КП/договор/резерв), НЕ правка текста.
function buildMissingFinding(topic, { segmentsTotal = 0 } = {}) {
  const resolution = RESOLUTIONS.includes(topic.resolution) ? topic.resolution : 'ask_customer';
  const resolutionLabel = RESOLUTION_LABELS[resolution] || resolution;
  const standard = topic.standard_text
    ? ` Стандарт компании: ${topic.standard_text}`
    : (topic.desc ? ` Что должно быть определено: ${topic.desc}.` : '');
  return {
    fragment: null,
    section_path: '',
    problem_type: 'условие_отсутствует',
    risk_category: 'существенные_условия',
    criticality: topic.criticality || 'high',
    suggested_action: RESOLUTION_TO_SUGGESTED_ACTION[resolution],
    suggested_redaction: topic.standard_text || null,
    review_comment:
      `Условие «${topic.name}» в ТЗ не обнаружено. Действие: ${resolutionLabel}.`,
    basis:
      `Тема «${topic.name}» не обнаружена ни в одной из ${segmentsTotal || 'проверенных'} частей ТЗ ` +
      `(проверены все части документа).${standard}`,
    confidence: 0.6,
    impact_level: CRIT_TO_IMPACT[topic.criticality] || 'high',
    impact_dimensions: topic.dimensions || ['contract'],
    required_action: RESOLUTION_TO_REQUIRED_ACTION[resolution],
    coverage_topic_key: topic.topic_key,
  };
}

const STATUS_LABELS = Object.freeze({
  matches: 'Соответствует',
  contradicts: 'Противоречит',
  missing: 'Отсутствует',
  ambiguous: 'Сформулировано неоднозначно',
  other_document: 'Есть только в другом документе',
  check_contract: 'Требует проверки проекта договора',
  not_applicable: 'Неприменимо к данному тендеру',
  resolved_in_contract: 'Урегулировано в договоре',
  risk_accepted: 'Риск принят',
});

const RESOLUTION_LABELS = Object.freeze({
  ask_customer: 'запрос Заказчику',
  add_assumption: 'тендерное допущение',
  exclude_from_price: 'исключение из цены',
  kp_condition: 'условие коммерческого предложения',
  check_contract: 'пункт для проверки проекта договора',
  risk_reserve: 'резерв риска',
  none: 'действий не требуется',
});

module.exports = {
  COVERAGE_STATUSES,
  AGENT_STATUSES,
  ENGINEER_ONLY_STATUSES,
  CLOSING_STATUSES,
  isClosingStatus,
  isTopicClosedByOverride,
  selectMissingTopics,
  RESOLUTIONS,
  RESOLUTION_TO_REQUIRED_ACTION,
  RESOLUTION_TO_SUGGESTED_ACTION,
  COVERAGE_TOPICS,
  PART_STATUS,
  normalizePartStatus,
  topicKeyOfCondition,
  topicKeyOfTopic,
  buildTopicList,
  aggregateCoverage,
  buildMissingFinding,
  STATUS_LABELS,
  RESOLUTION_LABELS,
};
