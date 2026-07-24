import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { api } from '../../services/api';
import { toastError } from '../../store/useToastStore';
import { useTenderStore } from '../../store/useTenderStore';

// Debug-вкладка слоя signals (новая архитектура анализа ТЗ).
// Не входит в основной wizard-сайдбар — доступна по /tenders/:id/debug/signals.

const TYPE_LABEL = {
  coverage: 'Покрытие (Стадия 1)',
  decision: 'Решения Q&A (Стадия 2)',
  condition: 'Условия (Стадия 3)',
  risk: 'Риски (Стадия 4)',
};

const TYPE_CLASS = {
  coverage: 'bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-300',
  decision: 'bg-violet-100 dark:bg-violet-900/40 text-violet-800 dark:text-violet-300',
  condition: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-300',
  risk: 'bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-300',
};

const FILTERS = ['all', 'coverage', 'decision', 'condition', 'risk'];

export default function SignalsPage() {
  const tenderId = useTenderStore((s) => s.tenderId);
  const [items, setItems] = useState([]);
  const [byType, setByType] = useState({});
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');

  const load = async () => {
    if (!tenderId) return;
    setLoading(true);
    try {
      const res = await api.listSignals(tenderId, filter === 'all' ? null : filter);
      setItems(res.items || []);
      setByType(res.by_type || {});
    } catch (err) { toastError(err.message); }
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [tenderId, filter]);

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Сигналы (debug)</h1>
        <button onClick={load} className="text-sm px-3 py-1 rounded border dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800">
          Обновить
        </button>
      </div>

      <p className="text-sm text-gray-500 dark:text-gray-400">
        Параллельный слой сигналов поверх находок стадий 1–4. Только для отладки новой
        архитектуры анализа — не влияет на рецензию и экспорт.
      </p>

      <div className="flex gap-2 flex-wrap">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={clsx(
              'text-sm px-3 py-1 rounded border dark:border-gray-700',
              filter === f ? 'bg-gray-900 text-white border-gray-900' : 'hover:bg-gray-50 dark:hover:bg-gray-800',
            )}
          >
            {f === 'all' ? 'Все' : TYPE_LABEL[f]}
            {f !== 'all' && byType[f] ? ` · ${byType[f]}` : ''}
          </button>
        ))}
      </div>

      {loading && <div className="text-gray-500 dark:text-gray-400">Загрузка…</div>}

      {!loading && !items.length && (
        <div className="text-gray-500 dark:text-gray-400">
          Сигналов нет. Запустите стадии 1–4 для этого тендера, затем обновите.
        </div>
      )}

      {!loading && !!items.length && (
        <div className="text-sm text-gray-600 dark:text-gray-400">Всего: {items.length}</div>
      )}

      <div className="space-y-3">
        {items.map((s) => (
          <div key={s.id} className="border dark:border-gray-700 rounded p-3 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={clsx('text-xs px-2 py-0.5 rounded', TYPE_CLASS[s.signal_type] || 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300')}>
                {TYPE_LABEL[s.signal_type] || s.signal_type}
              </span>
              <span className="text-xs text-gray-500 dark:text-gray-400">стадия {s.analysis_stage}</span>
              <span className="text-xs text-gray-500 dark:text-gray-400">вес {Number(s.weight).toFixed(2)}</span>
              {s.tz_clause && <span className="text-xs text-gray-400 dark:text-gray-500 truncate max-w-md">{s.tz_clause}</span>}
            </div>
            {s.source_fragment && (
              <div className="text-sm text-gray-800 dark:text-gray-100 whitespace-pre-wrap line-clamp-3">
                «{s.source_fragment}»
              </div>
            )}
            {s.signal_payload && (
              <pre className="text-xs bg-gray-50 dark:bg-gray-800 rounded p-2 overflow-x-auto">
                {JSON.stringify(s.signal_payload, null, 2)}
              </pre>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
