export const TENDER_TYPES = {
  general_contract: 'Генподряд (полный цикл)',
  shell: 'Коробка',
  monolith: 'Монолит',
  masonry: 'Кладка',
  waterproofing: 'Гидроизоляция',
  other: 'Другое',
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
  object_info: 'Доп. информация по объекту',
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
  2: 'ТЗ + Q&A форма (Таблица характеристик)',
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
