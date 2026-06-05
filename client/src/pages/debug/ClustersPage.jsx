import { useEffect, useState } from 'react';
import { api } from '../../services/api';
import { toastError, toastSuccess } from '../../store/useToastStore';
import { useTenderStore } from '../../store/useTenderStore';

// Debug-вкладка слоя clustering: объединение похожих замечаний по одному месту ТЗ.
// Кластер = одно место ТЗ + близкий смысл; внутри — исходные draft_issues (cluster
// items), смысл каждого сохранён. /tenders/:id/debug/clusters

const MODES = [
  { key: 'important', label: 'Только важное', hint: 'critical + high' },
  { key: 'working', label: 'Рабочий режим', hint: 'скрыты малозначимые кластеры' },
  { key: 'full', label: 'Полный режим', hint: 'все кластеры, включая скрытые' },
];

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

export default function ClustersPage() {
  const tenderId = useTenderStore((s) => s.tenderId);
  const [mode, setMode] = useState('working');
  const [items, setItems] = useState([]);
  const [byCriticality, setByCriticality] = useState({});
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);

  const load = async (m = mode) => {
    if (!tenderId) return;
    setLoading(true);
    try {
      const res = await api.listClusters(tenderId, m);
      setItems(res.items || []);
      setByCriticality(res.by_criticality || {});
    } catch (err) { toastError(err.message); }
    setLoading(false);
  };

  useEffect(() => { load(mode); /* eslint-disable-next-line */ }, [tenderId, mode]);

  const build = async () => {
    if (!tenderId) return;
    setBuilding(true);
    try {
      const res = await api.buildClusters(tenderId);
      const s = res.summary || {};
      toastSuccess(`Кластеры: ${s.clusters ?? 0} из ${s.draft_issues ?? 0} замечаний (объединено ${s.multi_item ?? 0})`);
      await load();
    } catch (err) { toastError(err.message); }
    setBuilding(false);
  };

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Кластеры замечаний (debug)</h1>
        <div className="flex gap-2">
          <button onClick={() => load()} className="text-sm px-3 py-1 rounded border hover:bg-gray-50">
            Обновить
          </button>
          <button
            onClick={build}
            disabled={building}
            className="text-sm px-3 py-1 rounded bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-50"
          >
            {building ? 'Сборка…' : 'Собрать кластеры'}
          </button>
        </div>
      </div>

      <p className="text-sm text-gray-500">
        Clustering сводит похожие замечания одного места ТЗ (общий пункт/фрагмент + близкий
        смысл + пересекающееся действие) в один кластер. Разные по смыслу проблемы в одном
        пункте (открытый объём ≠ риск оплаты) остаются разными кластерами — смысл не теряется.
        Параллельный слой поверх draft_issues + critic.
      </p>

      {/* Фильтры-режимы */}
      <div className="flex gap-2">
        {MODES.map((m) => (
          <button
            key={m.key}
            onClick={() => setMode(m.key)}
            className={`text-sm px-3 py-1.5 rounded border ${
              mode === m.key ? 'bg-gray-900 text-white border-gray-900' : 'bg-white hover:bg-gray-50'
            }`}
            title={m.hint}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="text-sm text-gray-600">
        Кластеров: {items.length}
        {Object.keys(byCriticality).length > 0 && (
          <span className="ml-2 text-gray-400">
            ({Object.entries(byCriticality).map(([k, v]) => `${k}: ${v}`).join(', ')})
          </span>
        )}
      </div>

      {loading && <div className="text-gray-500">Загрузка…</div>}

      {!loading && !items.length && (
        <div className="text-gray-500">
          Кластеров нет в этом режиме. Соберите draft issues и оцените critic, затем нажмите «Собрать кластеры».
        </div>
      )}

      <div className="space-y-4">
        {items.map((c) => (
          <div
            key={c.id}
            className={`border rounded p-4 space-y-3 ${c.show_to_engineer ? '' : 'opacity-60 bg-gray-50'}`}
          >
            {/* Шапка кластера: пункт ТЗ + итоговая критичность */}
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
              <span className="text-xs text-gray-400 font-mono">{c.semantic_bucket}</span>
            </div>

            <div className="font-medium text-gray-900">{c.cluster_title}</div>
            {c.tz_clause && <div className="text-xs text-gray-500">Пункт ТЗ: {c.tz_clause}</div>}

            {/* Объединённое описание проблемы (основания разных стадий) */}
            {c.merged_basis && (
              <div>
                <div className="text-xs uppercase tracking-wide text-gray-400 mb-1">Объединённое основание</div>
                <div className="text-sm text-gray-800 whitespace-pre-wrap">{c.merged_basis}</div>
              </div>
            )}

            {/* Рекомендуемое действие */}
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
    </div>
  );
}
