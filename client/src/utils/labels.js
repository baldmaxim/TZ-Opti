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

export const STAGE_LABELS = {
  1: 'ТЗ + Чек-лист + ВОР',
  2: 'Q&A → правки в ТЗ (решения СУ-10)',
  3: 'ТЗ + Типовые риски',
  4: 'Самоанализ ТЗ (скрытые работы / двусмыслия / срок)',
};

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
  accept: 'Примечание',
};

// Словарь типов замечаний — отображение "сырых" значений из БД на читаемые.
export const PROBLEM_TYPES = {
  // Целевые значения (для будущего LLM-агента)
  не_учтено_в_кп: 'Не учтено в КП',
  не_учтено_в_вор: 'Не учтено в ВОР',
  // Унаследованные от rule-based stage1
  не_учтено_но_есть_в_ТЗ: 'Не учтено в КП',
  не_учтено_но_есть_в_ВОР: 'Не учтено в ВОР',
  учтено_в_кп_без_подтверждения: 'Учтено в КП без подтверждения',
  статус_не_определён: 'Статус не определён',
  // Из других стадий (могут пересекаться)
  типовой_риск: 'Типовой риск',
};

export const formatProblemType = (raw) => {
  if (!raw) return '—';
  return PROBLEM_TYPES[raw] || raw.replace(/_/g, ' ');
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
