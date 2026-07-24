import { useEffect, useState } from 'react';
import { api } from '../../services/api';
import { toastError, toastSuccess } from '../../store/useToastStore';
import { useTenderStore } from '../../store/useTenderStore';
import SelfAnalysisFindings, { SELF_ANALYSIS_TYPE_LABEL as TYPE_LABEL } from '../../components/selfAnalysis/SelfAnalysisFindings';

// Debug-вкладка слоя self-analysis — НОВАЯ роль Стадии 5: quality-control над
// итогом разбора (кластеры + исходный ТЗ), а не второй поток issues.
// /tenders/:id/debug/self-analysis
// Вид находки — общий компонент SelfAnalysisFindings (тот же, что на «Самоанализ»).

const TYPES = [
  { key: null, label: 'Все', hint: 'все типы замечаний QC' },
  { key: 'missed_coverage', label: 'Пропуски', hint: 'что могли пропустить' },
  { key: 'weak_cluster', label: 'Слабые кластеры', hint: 'тонкое основание / нет рекомендации' },
  { key: 'cluster_contradiction', label: 'Противоречия', hint: 'конфликт кластеров одного места ТЗ' },
  { key: 'needs_enrichment', label: 'Усилить', hint: 'дополнить basis/redaction важного кластера' },
];

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
          <button onClick={() => load()} className="text-sm px-3 py-1 rounded border dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800">
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

      <p className="text-sm text-gray-500 dark:text-gray-400">
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
            className={`text-sm px-3 py-1.5 rounded border dark:border-gray-700 ${
              findingType === t.key ? 'bg-gray-900 text-white border-gray-900' : 'bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800'
            }`}
            title={t.hint}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="text-sm text-gray-600 dark:text-gray-400">
        Замечаний QC: {items.length}
        {Object.keys(byType).length > 0 && (
          <span className="ml-2 text-gray-400 dark:text-gray-500">
            ({Object.entries(byType).map(([k, v]) => `${TYPE_LABEL[k] || k}: ${v}`).join(', ')})
          </span>
        )}
      </div>

      {loading && <div className="text-gray-500 dark:text-gray-400">Загрузка…</div>}

      {!loading && !items.length && (
        <div className="text-gray-500 dark:text-gray-400">
          Замечаний нет. Соберите кластеры (debug → clusters), затем нажмите «Запустить self-analysis»
          — слой сам дособерёт конвейер, если кластеров ещё нет.
        </div>
      )}

      <SelfAnalysisFindings items={items} />
    </div>
  );
}
