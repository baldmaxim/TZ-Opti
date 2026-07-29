// Вкладки рецензии: Критичные / Рабочие / На проверку / Низкий приоритет /
// Скрытые фильтром / Все. Счётчики — по текущему набору кластеров (с учётом
// режима «Только существенные», чтобы цифры совпадали со списком).

import { REVIEW_TABS } from '../../utils/reviewBoard';

export default function ReviewTabs({ active, counts = {}, onChange }) {
  return (
    <div className="flex flex-wrap rounded border dark:border-gray-700 overflow-hidden text-xs" role="tablist">
      {REVIEW_TABS.map((t) => {
        const selected = active === t.key;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={selected}
            className={`px-2.5 py-1.5 whitespace-nowrap border-r last:border-r-0 dark:border-gray-700 ${
              selected
                ? 'bg-brand-600 text-white'
                : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'
            }`}
            onClick={() => onChange(t.key)}
          >
            {t.label}
            <span className={`ml-1 ${selected ? 'text-brand-100' : 'text-gray-400 dark:text-gray-500'}`}>
              {counts[t.key] ?? 0}
            </span>
          </button>
        );
      })}
    </div>
  );
}
