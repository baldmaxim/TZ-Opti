import { useEffect, useState } from 'react';
import { api } from '../../services/api';
import { toastError, toastSuccess } from '../../store/useToastStore';
import { useTenderStore } from '../../store/useTenderStore';
import ClusterList from '../../components/clusters/ClusterList';

// Debug-вкладка слоя clustering: объединение похожих замечаний по одному месту ТЗ.
// Кластер = одно место ТЗ + близкий смысл; внутри — исходные draft_issues (cluster
// items), смысл каждого сохранён. /tenders/:id/debug/clusters
// Вид карточки кластера — общий компонент ClusterList (тот же, что на «Анализ ТЗ»).

const MODES = [
  { key: 'important', label: 'Только важное', hint: 'critical + high' },
  { key: 'working', label: 'Рабочий режим', hint: 'скрыты малозначимые кластеры' },
  { key: 'full', label: 'Полный режим', hint: 'все кластеры, включая скрытые' },
];

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
          <button onClick={() => load()} className="text-sm px-3 py-1 rounded border dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800">
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

      <p className="text-sm text-gray-500 dark:text-gray-400">
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
            className={`text-sm px-3 py-1.5 rounded border dark:border-gray-700 ${
              mode === m.key ? 'bg-gray-900 text-white border-gray-900' : 'bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800'
            }`}
            title={m.hint}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="text-sm text-gray-600 dark:text-gray-400">
        Кластеров: {items.length}
        {Object.keys(byCriticality).length > 0 && (
          <span className="ml-2 text-gray-400 dark:text-gray-500">
            ({Object.entries(byCriticality).map(([k, v]) => `${k}: ${v}`).join(', ')})
          </span>
        )}
      </div>

      {loading && <div className="text-gray-500 dark:text-gray-400">Загрузка…</div>}

      {!loading && !items.length && (
        <div className="text-gray-500 dark:text-gray-400">
          Кластеров нет в этом режиме. Соберите draft issues и оцените critic, затем нажмите «Собрать кластеры».
        </div>
      )}

      <ClusterList items={items} />
    </div>
  );
}
