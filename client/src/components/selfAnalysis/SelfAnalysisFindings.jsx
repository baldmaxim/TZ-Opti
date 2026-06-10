// Презентационный список замечаний самоанализа (QC над итогом разбора).
// Единый вид для основного экрана «Самоанализ» и debug-страницы.

export const SELF_ANALYSIS_TYPE_LABEL = {
  missed_coverage: 'Пропуск',
  weak_cluster: 'Слабый кластер',
  cluster_contradiction: 'Противоречие',
  needs_enrichment: 'Усилить',
};

const TYPE_CLASS = {
  missed_coverage: 'bg-purple-100 text-purple-800',
  weak_cluster: 'bg-amber-100 text-amber-800',
  cluster_contradiction: 'bg-red-100 text-red-800',
  needs_enrichment: 'bg-blue-100 text-blue-800',
};

const SOURCE_CLASS = {
  heuristic: 'bg-gray-100 text-gray-600',
  llm: 'bg-emerald-100 text-emerald-700',
};

export default function SelfAnalysisFindings({ items = [] }) {
  return (
    <div className="space-y-4">
      {items.map((f) => (
        <div key={f.id} className="border rounded p-4 space-y-2">
          {/* Шапка: тип находки + источник + уверенность */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-xs px-2 py-0.5 rounded font-medium ${TYPE_CLASS[f.finding_type] || ''}`}>
              {SELF_ANALYSIS_TYPE_LABEL[f.finding_type] || f.finding_type}
            </span>
            <span className={`text-xs px-2 py-0.5 rounded ${SOURCE_CLASS[f.source] || ''}`}>
              {f.source === 'llm' ? 'LLM' : 'эвристика'}
            </span>
            <span className="text-xs text-gray-400">conf {Number(f.confidence ?? 0).toFixed(2)}</span>
          </div>

          {/* Адресат: кластер или весь ТЗ */}
          <div className="text-xs text-gray-500">
            {f.cluster_id ? (
              <>Кластер: {f.cluster_title || f.cluster_id}{f.cluster_tz_clause ? ` · ${f.cluster_tz_clause}` : ''}</>
            ) : (
              <>Про весь ТЗ / пропуск (вне конкретного кластера)</>
            )}
            {f.related_cluster_id && <> · конфликт с кластером {f.related_cluster_id}</>}
          </div>

          <div className="text-sm text-gray-800 whitespace-pre-wrap">{f.comment}</div>

          {f.suggested_improvement && (
            <div>
              <div className="text-xs uppercase tracking-wide text-gray-400 mb-1">Как улучшить</div>
              <div className="text-sm text-gray-700 whitespace-pre-wrap">{f.suggested_improvement}</div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
