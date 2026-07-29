// Компактный список замечаний текущей вкладки. Лёгкие строки (без карточек) —
// список остаётся быстрым и на 500+ замечаниях; полная карточка рендерится
// только для выбранного замечания (отдельным компонентом FindingCard).

import { useEffect } from 'react';
import { clusterTopic, truncate } from '../../utils/format';
import { GATE_HIDING } from '../../utils/reviewBoard';

const IMPACT_DOT = {
  critical: 'bg-red-600',
  high: 'bg-orange-500',
  medium: 'bg-amber-400',
  low: 'bg-blue-400',
  none: 'bg-gray-300 dark:bg-gray-600',
};

const STATE_ICON = {
  accepted: { icon: '✓', cls: 'text-green-600 dark:text-green-400', title: 'Принято' },
  rejected: { icon: '✕', cls: 'text-red-500', title: 'Отклонено' },
  deferred: { icon: '⏸', cls: 'text-amber-500', title: 'На проверку' },
  merged: { icon: '⇄', cls: 'text-purple-500', title: 'Объединено' },
};

export default function FindingList({ items = [], selectedId, stateById = new Map(), gateById = new Map(), onSelect }) {
  // Выбранная строка всегда в видимой области списка (навигация стрелками).
  useEffect(() => {
    if (!selectedId) return;
    const el = document.getElementById(`finding-row-${selectedId}`);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  if (!items.length) return null;

  return (
    <div className="card p-0 overflow-y-auto max-h-44 lg:max-h-56 shrink-0 divide-y dark:divide-gray-700">
      {items.map((c, i) => {
        const selected = c.id === selectedId;
        const state = stateById.get(c.id) || null;
        const stateMeta = state ? STATE_ICON[state] : null;
        const gate = gateById.get(c.id) || null;
        const gateHides = gate && GATE_HIDING.includes(gate.qualification);
        const level = c.overall_impact_level || c.overall_criticality;
        return (
          <button
            key={c.id}
            id={`finding-row-${c.id}`}
            type="button"
            onClick={() => onSelect(c.id)}
            className={`w-full flex items-center gap-2 px-2 py-1.5 text-left text-xs ${
              selected
                ? 'bg-brand-50 dark:bg-brand-900/30 border-l-2 border-brand-600'
                : 'hover:bg-gray-50 dark:hover:bg-gray-700/50 border-l-2 border-transparent'
            }`}
          >
            <span className="text-gray-400 dark:text-gray-500 w-8 shrink-0 text-right">№{i + 1}</span>
            <span
              className={`w-2 h-2 rounded-full shrink-0 ${IMPACT_DOT[level] || 'bg-gray-300 dark:bg-gray-600'}`}
              title={level || 'уровень не оценён'}
            />
            <span className="flex-1 truncate text-gray-800 dark:text-gray-200">
              {truncate(clusterTopic(c) || c.cluster_title || c.final_problem_type || '—', 90)}
            </span>
            {gateHides && (
              <span
                className="shrink-0 text-purple-600 dark:text-purple-400"
                title="Gate предлагает скрыть это замечание (рекомендация, не решение)"
              >
                ⚑
              </span>
            )}
            {stateMeta && (
              <span className={`shrink-0 ${stateMeta.cls}`} title={stateMeta.title}>
                {stateMeta.icon}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
