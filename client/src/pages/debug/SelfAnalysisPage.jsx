import { useEffect, useState } from 'react';
import { api } from '../../services/api';
import { toastError, toastSuccess } from '../../store/useToastStore';
import { useTenderStore } from '../../store/useTenderStore';

// Debug-вкладка слоя self-analysis — НОВАЯ роль Стадии 5: quality-control над
// итогом разбора (кластеры + исходный ТЗ), а не второй поток issues.
// /tenders/:id/debug/self-analysis

const TYPES = [
  { key: null, label: 'Все', hint: 'все типы замечаний QC' },
  { key: 'missed_coverage', label: 'Пропуски', hint: 'что могли пропустить' },
  { key: 'weak_cluster', label: 'Слабые кластеры', hint: 'тонкое основание / нет рекомендации' },
  { key: 'cluster_contradiction', label: 'Противоречия', hint: 'конфликт кластеров одного места ТЗ' },
  { key: 'needs_enrichment', label: 'Усилить', hint: 'дополнить basis/redaction важного кластера' },
];

const TYPE_LABEL = {
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

export default function SelfAnalysisPage() {
  const tenderId = useTenderStore((s) => s.tenderId);
  const [findingType, setFindingType] = useState(null);
  const [items, setItems] = useState([]);
  const [byType, setByType] = useState({});
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);

  const load = async (ft = findingType) => {
    if (!tenderId) return;
    setLoading(true);
    try {
      const res = await api.listSelfAnalysis(tenderId, ft);
      setItems(res.items || []);
      setByType(res.by_type || {});
    } catch (err) { toastError(err.message); }
    setLoading(false);
  };

  useEffect(() => { load(findingType); /* eslint-disable-next-line */ }, [tenderId, findingType]);

  const build = async () => {
    if (!tenderId) return;
    setBuilding(true);
    try {
      const res = await api.buildSelfAnalysis(tenderId);
      const s = res.summary || {};
      toastSuccess(
        `Self-analysis: ${s.findings ?? 0} замечаний по ${s.clusters ?? 0} кластерам ` +
        `(эвристик ${s.heuristic ?? 0}, LLM ${s.llm ?? 0})`,
      );
      await load();
    } catch (err) { toastError(err.message); }
    setBuilding(false);
  };

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Самоанализ итога — QC (debug)</h1>
        <div className="flex gap-2">
          <button onClick={() => load()} className="text-sm px-3 py-1 rounded border hover:bg-gray-50">
            Обновить
          </button>
          <button
            onClick={build}
            disabled={building}
            className="text-sm px-3 py-1 rounded bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-50"
          >
            {building ? 'Проверка…' : 'Запустить self-analysis'}
          </button>
        </div>
      </div>

      <p className="text-sm text-gray-500">
        Новая роль Стадии 5: не второй поток issues, а quality-control над итогом. Проверяет уже
        собранные кластеры + исходный ТЗ и отвечает на 4 вопроса: что могли пропустить, где кластеры
        слабые, где противоречие между кластерами, где усилить basis/review_comment/suggested_redaction.
        Эвристики работают без LLM; LLM-обогащение — best-effort поверх них. Параллельный слой: в issues
        ничего не пишется.
      </p>

      {/* Фильтры по типу */}
      <div className="flex gap-2 flex-wrap">
        {TYPES.map((t) => (
          <button
            key={t.key || 'all'}
            onClick={() => setFindingType(t.key)}
            className={`text-sm px-3 py-1.5 rounded border ${
              findingType === t.key ? 'bg-gray-900 text-white border-gray-900' : 'bg-white hover:bg-gray-50'
            }`}
            title={t.hint}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="text-sm text-gray-600">
        Замечаний QC: {items.length}
        {Object.keys(byType).length > 0 && (
          <span className="ml-2 text-gray-400">
            ({Object.entries(byType).map(([k, v]) => `${TYPE_LABEL[k] || k}: ${v}`).join(', ')})
          </span>
        )}
      </div>

      {loading && <div className="text-gray-500">Загрузка…</div>}

      {!loading && !items.length && (
        <div className="text-gray-500">
          Замечаний нет. Соберите кластеры (debug → clusters), затем нажмите «Запустить self-analysis»
          — слой сам дособерёт конвейер, если кластеров ещё нет.
        </div>
      )}

      <div className="space-y-4">
        {items.map((f) => (
          <div key={f.id} className="border rounded p-4 space-y-2">
            {/* Шапка: тип находки + источник + уверенность */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`text-xs px-2 py-0.5 rounded font-medium ${TYPE_CLASS[f.finding_type] || ''}`}>
                {TYPE_LABEL[f.finding_type] || f.finding_type}
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
    </div>
  );
}
