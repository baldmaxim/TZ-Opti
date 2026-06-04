export const TENDER_TYPES = {
  general_contract: 'Генподряд (полный цикл)',
  shell: 'Коробка',
};

export const TENDER_STATUSES = {
  draft: 'Черновик',
  in_progress: 'В работе',
  submitted: 'Подано',
  won: 'Выиграно',
  lost: 'Проиграно',
  archived: 'Архив',
};

export const DOC_TYPES = {
  tz: 'ТЗ',
  pd_rd: 'ПД / РД',
  vor: 'ВОР',
  checklist: 'Чек-лист состава работ',
  company_conditions: 'Существенные условия компании',
  risks: 'База рисков',
  qa: 'Q&A форма',
  other: 'Другое',
};

export const CRITICALITY = {
  low: 'Низкая',
  medium: 'Средняя',
  high: 'Высокая',
  critical: 'Критическая',
};

// ЕДИНЫЙ ИСТОЧНИК названий стадий на клиенте. Все подписи (визард, страница
// стадии, экран обзора, рецензия) берутся отсюда — не хардкодить названия в
// других местах. Серверный аналог — STAGE_LABELS в stageAnalysisEngine.js;
// тексты title должны совпадать.
export const STAGE_META = {
  1: {
    title: 'ТЗ + Чек-лист + ВОР',
    description: 'На основе чек-листа и ВОР находим в тексте ТЗ работы, не учтённые в расчёте КП/ВОР.',
  },
  2: {
    title: 'Q&A + Характеристики',
    description: 'Сверяем ТЗ с принятыми решениями Q&A (СУ-10) и таблицей характеристик; выносим несоответствия.',
  },
  3: {
    title: 'Существенные условия компании',
    description: 'Сверяем ТЗ с существенными условиями компании и выносим места ТЗ, которые им противоречат.',
  },
  4: {
    title: 'Типовые риски',
    description: 'Ищем в ТЗ прямые и косвенные упоминания типовых рисков, ведущих к доп. неоплачиваемым работам / потерям ГП.',
  },
  5: {
    title: 'Самоанализ ТЗ',
    description: 'Ищем в ТЗ скрытые работы, двусмысленные формулировки и факторы, влияющие на срок.',
  },
};

export const stageTitle = (n) => STAGE_META[n]?.title || `Стадия ${n}`;
export const stageShort = (n) => `Стадия ${n}`;
export const stageLabel = (n) => `Стадия ${n}: ${stageTitle(n)}`;
export const stageDescription = (n) => STAGE_META[n]?.description || '';

// Полное название стадии (для подписей вне визарда, напр. рецензия). Берём из
// единого STAGE_META.
export const STAGE_LABELS = Object.fromEntries(
  Object.keys(STAGE_META).map((n) => [n, STAGE_META[n].title]),
);

// ЕДИНЫЙ список номеров стадий (1..5) — производный от STAGE_META.
// Все обходы стадий (рецензия, визард, обзор) берут его отсюда, чтобы при
// изменении числа стадий не править захардкоженные массивы по файлам.
export const STAGE_NUMBERS = Object.keys(STAGE_META)
  .map(Number)
  .sort((a, b) => a - b);

export const STAGE_STATUS = {
  open: 'Готова к запуску',
  running: 'Выполняется',
  reviewing: 'Согласование решений',
  finished: 'Завершена',
  locked: 'Заблокирована',
};

export const ACTIONS = {
  comment: 'Оставить комментарий',
  replace: 'Заменить формулировку',
  delete: 'Удалить из ТЗ',
  remove_from_scope: 'Вынести из объёма',
  clarify: 'Уточнить',
  limit_scope: 'Ограничить объём',
  assumption: 'Вынести в допущения',
};

export const REVIEW_STATUS = {
  pending: 'Ожидает',
  accepted: 'Принято',
  rejected: 'Отклонено',
  edited: 'Отредактировано',
};

export const DECISIONS = {
  accept: 'Принять',
  reject: 'Отклонить',
  edit: 'Редактировать',
  delete: 'Удалить из ТЗ',
  remove_from_scope: 'Вынести из объёма',
};

// Лейблы решений в терминах пользователя (Стадия 1, целевая модель).
// Маппинг 4 UI-кнопок на существующие БД-decisions.
export const USER_DECISION_LABELS = {
  reject: 'Отклонить',
  delete: 'Удалить',
  edit: 'Изменить',
  remove_from_scope: 'Вынести из объёма',
  accept: 'Примечание',
};

// Словарь типов замечаний — отображение "сырых" значений из БД на читаемые.
// Сгруппирован по стадиям-владельцам (см. server/services/review/stageDomains.js).
export const PROBLEM_TYPES = {
  // Стадия 1 — покрытие расчёта
  не_учтено_в_кп: 'Не учтено в КП',
  не_учтено_в_вор: 'Не учтено в ВОР',
  не_в_обоих: 'Нет ни в КП, ни в ВОР',
  статус_не_определён: 'Статус не определён',
  // Стадия 2 — Q&A + характеристики
  qa_противоречит_тз: 'Q&A: противоречит ТЗ',
  qa_исключено_из_кп: 'Q&A: исключено из КП',
  qa_отсутствует_информация: 'Q&A: нет данных',
  qa_отложенный_ответ: 'Q&A: ответ отложен',
  qa_подтверждено: 'Q&A: подтверждено',
  qa_влияет_на_контур: 'Q&A: влияет на контур',
  char_противоречит_тз: 'Характеристика противоречит ТЗ',
  char_не_отражена: 'Характеристика не отражена',
  // Стадия 3 — существенные условия
  условие_противоречит: 'Условие компании: противоречие',
  // Стадия 4 — типовые риски
  типовой_риск: 'Типовой риск',
  // Стадия 5 — самоанализ ТЗ
  скрытые_работы: 'Скрытые работы',
  двусмысленная_формулировка: 'Двусмысленная формулировка',
  влияние_на_срок: 'Влияние на срок',
  // Унаследованные от rule-based stage1 (superseded)
  не_учтено_но_есть_в_ТЗ: 'Не учтено в КП',
  не_учтено_но_есть_в_ВОР: 'Не учтено в ВОР',
  учтено_в_кп_без_подтверждения: 'Учтено в КП без подтверждения',
};

// Тип результата на стадию (зеркало STAGE_DOMAINS на сервере).
export const STAGE_RESULT_TYPE = {
  1: 'Покрытие расчёта (объём / ВОР)',
  2: 'Решения Q&A + характеристики',
  3: 'Существенные условия компании',
  4: 'Типовые риски',
  5: 'Самоанализ ТЗ',
};

// Категории риска (risk_category) → читаемые. Категории Стадии 4 приходят из
// библиотеки рисков уже по-русски и рендерятся как есть (фолбэк).
export const RISK_CATEGORIES = {
  покрытие_расчёта: 'Покрытие расчёта',
  договорной: 'Договорные',
  объём_работ: 'Объём работ',
  данные: 'Данные',
  фиксация: 'Фиксация',
  характеристики: 'Характеристики',
  существенные_условия: 'Существенные условия',
  объём_и_обязательства: 'Объём и обязательства',
  юридические_формулировки: 'Юридические формулировки',
  график: 'График',
};

export const formatProblemType = (raw) => {
  if (!raw) return '—';
  return PROBLEM_TYPES[raw] || raw.replace(/_/g, ' ');
};

export const formatRiskCategory = (raw) => {
  if (!raw) return '—';
  return RISK_CATEGORIES[raw] || raw.replace(/_/g, ' ');
};

export const labelFor = (map, key, fallback = '—') => map[key] || fallback;

export const criticalityClass = (c) => {
  if (c === 'critical') return 'bg-red-100 text-red-800';
  if (c === 'high') return 'bg-orange-100 text-orange-800';
  if (c === 'medium') return 'bg-amber-100 text-amber-800';
  if (c === 'low') return 'bg-blue-100 text-blue-800';
  return 'bg-gray-100 text-gray-800';
};

export const statusClass = (s) => {
  if (s === 'finished') return 'bg-green-100 text-green-800';
  if (s === 'reviewing' || s === 'in_progress') return 'bg-blue-100 text-blue-800';
  if (s === 'locked') return 'bg-gray-100 text-gray-500';
  if (s === 'won') return 'bg-green-100 text-green-800';
  if (s === 'lost') return 'bg-red-100 text-red-800';
  return 'bg-amber-100 text-amber-800';
};
