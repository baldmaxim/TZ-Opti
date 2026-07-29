// Презентационный список кластеров замечаний (одно требование + близкий смысл).
// Единый вид для основного экрана «Анализ ТЗ» и debug-страницы кластеров —
// чтобы карточка кластера выглядела одинаково везде.
//
// Повторённое в нескольких пунктах ТЗ требование — ОДНА карточка: цитата
// первичного вхождения + подпись «Обнаружено ещё в N местах» со списком
// остальных вхождений.

import { occurrenceNote, otherOccurrences, formatTzClause } from '../../utils/format';

const CRIT_CLASS = {
  critical: 'bg-red-600 text-white',
  high: 'bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-300',
  medium: 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300',
  low: 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400',
};

const ROLE_CLASS = {
  primary: 'bg-gray-900 text-white',
  related: 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400',
};

export default function ClusterList({ items = [] }) {
  return (
    <div className="space-y-4">
      {items.map((c) => {
        const repeated = occurrenceNote(c);
        const occurrences = otherOccurrences(c);
        const sections = (c.affected_sections || []).filter(Boolean);
        return (
        <div
          key={c.id}
          className={`border dark:border-gray-700 rounded p-4 space-y-3 ${c.show_to_engineer ? '' : 'opacity-60 bg-gray-50 dark:bg-gray-800'}`}
        >
          {/* Шапка кластера: критичность + пункт ТЗ + кол-во замечаний */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-xs px-2 py-0.5 rounded font-medium ${CRIT_CLASS[c.overall_criticality] || ''}`}>
              {c.overall_criticality}
            </span>
            {!c.show_to_engineer && (
              <span className="text-xs px-2 py-0.5 rounded bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400">скрыт</span>
            )}
            <span className="text-xs px-2 py-0.5 rounded bg-indigo-50 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300">
              {c.item_count} замеч.
            </span>
            {Number(c.occurrence_count) > 1 && (
              <span className="text-xs px-2 py-0.5 rounded bg-purple-50 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300">
                {c.occurrence_count} мест в ТЗ
              </span>
            )}
            {c.final_problem_type && (
              <span className="text-xs text-gray-500 dark:text-gray-400">{c.final_problem_type}</span>
            )}
            {c.semantic_bucket && (
              <span className="text-xs text-gray-400 dark:text-gray-500 font-mono">{c.semantic_bucket}</span>
            )}
          </div>

          <div className="font-medium text-gray-900 dark:text-gray-100">{c.cluster_title}</div>
          {c.tz_clause && <div className="text-xs text-gray-500 dark:text-gray-400">Пункт ТЗ: {c.tz_clause}</div>}

          {/* Представительная цитата + прочие вхождения того же требования */}
          {c.representative_fragment && (
            <div className="text-sm text-gray-700 dark:text-gray-300 italic border-l-2 border-gray-300 dark:border-gray-700 pl-2 whitespace-pre-wrap">
              «{c.representative_fragment}»
            </div>
          )}
          {repeated && (
            <details>
              <summary className="text-xs text-brand-600 cursor-pointer hover:underline">
                {repeated}
                {sections.length > 0 && ` · ${sections.join(', ')}`}
              </summary>
              <ul className="mt-1 space-y-1">
                {occurrences.map((e, i) => (
                  <li key={e.draft_issue_id || i} className="text-xs text-gray-600 dark:text-gray-400 border-l-2 border-gray-200 dark:border-gray-700 pl-2">
                    {e.tz_clause && <div className="text-gray-500 dark:text-gray-500">{formatTzClause(e.tz_clause)}</div>}
                    {e.fragment && <div className="italic whitespace-pre-wrap">«{e.fragment}»</div>}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {/* Объединённое основание (basis) */}
          {c.merged_basis && (
            <div>
              <div className="text-xs uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-1">Объединённое основание</div>
              <div className="text-sm text-gray-800 dark:text-gray-100 whitespace-pre-wrap">{c.merged_basis}</div>
            </div>
          )}

          {/* Рекомендация (recommendation) */}
          {c.merged_recommendation && (
            <div>
              <div className="text-xs uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-1">Рекомендация</div>
              <div className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap">{c.merged_recommendation}</div>
            </div>
          )}

          {/* Подпункты — исходные draft_issues, смысл каждого сохранён */}
          {Array.isArray(c.items) && c.items.length > 0 && (
            <div className="border-t dark:border-gray-700 pt-2 space-y-2">
              <div className="text-xs uppercase tracking-wide text-gray-400 dark:text-gray-500">Замечания в кластере</div>
              {c.items.map((it) => (
                <div key={it.draft_issue_id} className="flex items-start gap-2 text-sm">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${ROLE_CLASS[it.item_role] || ''}`}>
                    {it.item_role}
                  </span>
                  {it.category && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 shrink-0">
                      {it.category}
                    </span>
                  )}
                  <span className="text-gray-700 dark:text-gray-300">{it.basis || it.source_fragment || it.problem_type}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        );
      })}
    </div>
  );
}
