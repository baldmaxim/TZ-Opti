'use strict';

// Единый реестр «действий» (suggested_action) — что анализ предлагает сделать с
// фрагментом ТЗ. ОДИН источник истины для: LLM-схем стадий (enum), нормализации
// находок (shared/llmStage), кластеризации (actionFamily) и self-analysis.
//
// Зачем: значения действий рассинхронились. LLM-схемы отдавали
// replace/limit_scope/clarify/assumption, а clustering.actionFamily знал только
// delete/remove_from_scope/edit → replace и limit_scope ОШИБОЧНО попадали в
// семейство note (аннотации), из-за чего замечания «поменять текст» кластеризовались
// вместе с «просто прокомментировать». Теперь и enum, и семейства берутся отсюда.

// Канонические действия (ровно то, что может стоять в suggested_action).
const ACTIONS = Object.freeze({
  DELETE: 'delete', // убрать фрагмент из ТЗ (удаление)
  REMOVE_FROM_SCOPE: 'remove_from_scope', // вынести из объёма ГП
  REPLACE: 'replace', // заменить формулировку (нужен suggested_redaction)
  LIMIT_SCOPE: 'limit_scope', // ограничить объём/применимость пункта
  CLARIFY: 'clarify', // задать вопрос / уточнить у заказчика
  ASSUMPTION: 'assumption', // зафиксировать допущение в КП
  COMMENT: 'comment', // примечание без правки текста
});

// Порядок — канонический (идёт в JSON-схемы LLM как enum).
const ALL_ACTIONS = Object.freeze([
  ACTIONS.DELETE,
  ACTIONS.REMOVE_FROM_SCOPE,
  ACTIONS.REPLACE,
  ACTIONS.LIMIT_SCOPE,
  ACTIONS.CLARIFY,
  ACTIONS.ASSUMPTION,
  ACTIONS.COMMENT,
]);

const ACTION_SET = new Set(ALL_ACTIONS);

// Легаси-алиасы → канон. Историческое 'edit' = «заменить формулировку» → replace
// (обратная совместимость: старые issues/draft_issues/фикстуры хранят 'edit').
const ALIASES = Object.freeze({
  edit: ACTIONS.REPLACE,
});

// Семейства действий — для кластеризации: «пересекающиеся» действия считаются
// одним измерением. КЛЮЧЕВОЕ: replace/limit_scope МЕНЯЮТ текст → modify, а НЕ note.
const FAMILY = Object.freeze({
  REMOVE: 'remove', // delete, remove_from_scope
  MODIFY: 'modify', // replace, limit_scope  (+ легаси edit)
  NOTE: 'note', // clarify, assumption, comment
});

const ACTION_FAMILY = Object.freeze({
  [ACTIONS.DELETE]: FAMILY.REMOVE,
  [ACTIONS.REMOVE_FROM_SCOPE]: FAMILY.REMOVE,
  [ACTIONS.REPLACE]: FAMILY.MODIFY,
  [ACTIONS.LIMIT_SCOPE]: FAMILY.MODIFY,
  [ACTIONS.CLARIFY]: FAMILY.NOTE,
  [ACTIONS.ASSUMPTION]: FAMILY.NOTE,
  [ACTIONS.COMMENT]: FAMILY.NOTE,
});

// Фаззи-словарь (для интерпретации свободного текста от LLM: синонимы/русские
// формулировки). Порядок важен — «вынести из объёма» проверяем ДО «удалить».
const FUZZY = [
  [/(вынес|out_of_scope|remove_from|изъ)/, ACTIONS.REMOVE_FROM_SCOPE],
  [/(огранич|limit)/, ACTIONS.LIMIT_SCOPE],
  [/(замен|replace|edit|правк)/, ACTIONS.REPLACE],
  [/(удал|delete|remove)/, ACTIONS.DELETE],
  [/(допущ|assum)/, ACTIONS.ASSUMPTION],
  [/(уточн|clarif|вопрос)/, ACTIONS.CLARIFY],
  [/(коммент|comment|note|примеч)/, ACTIONS.COMMENT],
];

function isAction(value) {
  return ACTION_SET.has(value);
}

function normKey(value) {
  return String(value == null ? '' : value).trim().toLowerCase().replace(/[\s-]+/g, '_');
}

// Привести значение к канону: точное совпадение → легаси-алиас → fallback.
// Без фаззи-догадок (для уже структурированных значений: draft/issue/бакет).
function canonicalAction(value, fallback = ACTIONS.COMMENT) {
  const s = normKey(value);
  if (ACTION_SET.has(s)) return s;
  if (ALIASES[s]) return ALIASES[s];
  return ACTION_SET.has(fallback) ? fallback : ACTIONS.COMMENT;
}

// То же + фаззи-интерпретация свободного текста (для сырого вывода LLM).
function coerceAction(value, fallback = ACTIONS.COMMENT) {
  const s = normKey(value);
  if (ACTION_SET.has(s)) return s;
  if (ALIASES[s]) return ALIASES[s];
  for (const [re, action] of FUZZY) {
    if (re.test(s)) return action;
  }
  return ACTION_SET.has(fallback) ? fallback : ACTIONS.COMMENT;
}

// Семейство действия (для кластеризации). Принимает сырое ИЛИ каноническое
// значение; легаси 'edit' и 'replace'/'limit_scope' → 'modify' (НЕ 'note').
// Неизвестное значение попадает в 'note' (безопасно: аннотация не сливается с
// «убрать»/«поменять»).
function actionFamily(value) {
  return ACTION_FAMILY[canonicalAction(value, ACTIONS.COMMENT)] || FAMILY.NOTE;
}

module.exports = {
  ACTIONS,
  ALL_ACTIONS,
  ACTION_SET,
  ALIASES,
  FAMILY,
  ACTION_FAMILY,
  isAction,
  canonicalAction,
  coerceAction,
  actionFamily,
};
