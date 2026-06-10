// Презентационный список кластеров замечаний (одно место ТЗ + близкий смысл).
// Единый вид для основного экрана «Анализ ТЗ» и debug-страницы кластеров —
// чтобы карточка кластера выглядела одинаково везде.

const CRIT_CLASS = {
  critical: 'bg-red-600 text-white',
  high: 'bg-red-100 text-red-800',
  medium: 'bg-amber-100 text-amber-800',
  low: 'bg-gray-100 text-gray-500',
};

const ROLE_CLASS = {
  primary: 'bg-gray-900 text-white',
  related: 'bg-gray-100 text-gray-600',
};

export default function ClusterList({ items = [] }) {
  return (
    <div className="space-y-4">
      {items.map((c) => (
        <div
          key={c.id}
          className={`border rounded p-4 space-y-3 ${c.show_to_engineer ? '' : 'opacity-60 bg-gray-50'}`}
        >
          {/* Шапка кластера: критичность + пункт ТЗ + кол-во замечаний */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-xs px-2 py-0.5 rounded font-medium ${CRIT_CLASS[c.overall_criticality] || ''}`}>
              {c.overall_criticality}
            </span>
            {!c.show_to_engineer && (
              <span className="text-xs px-2 py-0.5 rounded bg-gray-200 text-gray-600">скрыт</span>
            )}
            <span className="text-xs px-2 py-0.5 rounded bg-indigo-50 text-indigo-700">
              {c.item_count} замеч.
            </span>
            {c.final_problem_type && (
              <span className="text-xs text-gray-500">{c.final_problem_type}</span>
            )}
            {c.semantic_bucket && (
              <span className="text-xs text-gray-400 font-mono">{c.semantic_bucket}</span>
            )}
          </div>

          <div className="font-medium text-gray-900">{c.cluster_title}</div>
          {c.tz_clause && <div className="text-xs text-gray-500">Пункт ТЗ: {c.tz_clause}</div>}

          {/* Объединённое основание (basis) */}
          {c.merged_basis && (
            <div>
              <div className="text-xs uppercase tracking-wide text-gray-400 mb-1">Объединённое основание</div>
              <div className="text-sm text-gray-800 whitespace-pre-wrap">{c.merged_basis}</div>
            </div>
          )}

          {/* Рекомендация (recommendation) */}
          {c.merged_recommendation && (
            <div>
              <div className="text-xs uppercase tracking-wide text-gray-400 mb-1">Рекомендация</div>
              <div className="text-sm text-gray-700 whitespace-pre-wrap">{c.merged_recommendation}</div>
            </div>
          )}

          {/* Подпункты — исходные draft_issues, смысл каждого сохранён */}
          {Array.isArray(c.items) && c.items.length > 0 && (
            <div className="border-t pt-2 space-y-2">
              <div className="text-xs uppercase tracking-wide text-gray-400">Замечания в кластере</div>
              {c.items.map((it) => (
                <div key={it.draft_issue_id} className="flex items-start gap-2 text-sm">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${ROLE_CLASS[it.item_role] || ''}`}>
                    {it.item_role}
                  </span>
                  {it.category && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 shrink-0">
                      {it.category}
                    </span>
                  )}
                  <span className="text-gray-700">{it.basis || it.source_fragment || it.problem_type}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
