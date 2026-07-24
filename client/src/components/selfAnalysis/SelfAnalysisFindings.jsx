// Презентационный список замечаний самоанализа (QC над итогом разбора).
// Единый вид для основного экрана «Самоанализ» и debug-страницы.

export const SELF_ANALYSIS_TYPE_LABEL = {
  missed_coverage: 'Пропуск',
  weak_cluster: 'Слабый кластер',
  cluster_contradiction: 'Противоречие',
  needs_enrichment: 'Усилить',
};

const TYPE_CLASS = {
  missed_coverage: 'bg-purple-100 dark:bg-purple-900/40 text-purple-800 dark:text-purple-300',
  weak_cluster: 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300',
  cluster_contradiction: 'bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-300',
  needs_enrichment: 'bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-300',
};

const SOURCE_CLASS = {
  heuristic: 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400',
  llm: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300',
};

export default function SelfAnalysisFindings({ items = [] }) {
  return (
    <div className="space-y-4">
      {items.map((f) => (
        <div key={f.id} className="border dark:border-gray-700 rounded p-4 space-y-2">
          {/* Шапка: тип находки + источник + уверенность */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-xs px-2 py-0.5 rounded font-medium ${TYPE_CLASS[f.finding_type] || ''}`}>
              {SELF_ANALYSIS_TYPE_LABEL[f.finding_type] || f.finding_type}
            </span>
            <span className={`text-xs px-2 py-0.5 rounded ${SOURCE_CLASS[f.source] || ''}`}>
              {f.source === 'llm' ? 'LLM' : 'эвристика'}
            </span>
            <span className="text-xs text-gray-400 dark:text-gray-500">conf {Number(f.confidence ?? 0).toFixed(2)}</span>
          </div>

          {/* Адресат: кластер или весь ТЗ */}
          <div className="text-xs text-gray-500 dark:text-gray-400">
            {f.cluster_id ? (
              <>Кластер: {f.cluster_title || f.cluster_id}{f.cluster_tz_clause ? ` · ${f.cluster_tz_clause}` : ''}</>
            ) : (
              <>Про весь ТЗ / пропуск (вне конкретного кластера)</>
            )}
            {f.related_cluster_id && <> · конфликт с кластером {f.related_cluster_id}</>}
          </div>

          <div className="text-sm text-gray-800 dark:text-gray-100 whitespace-pre-wrap">{f.comment}</div>

          {f.suggested_improvement && (
            <div>
              <div className="text-xs uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-1">Как улучшить</div>
              <div className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap">{f.suggested_improvement}</div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
