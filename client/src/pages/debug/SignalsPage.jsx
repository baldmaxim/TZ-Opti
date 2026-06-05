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
  coverage: 'bg-blue-100 text-blue-800',
  decision: 'bg-violet-100 text-violet-800',
  condition: 'bg-emerald-100 text-emerald-800',
  risk: 'bg-red-100 text-red-800',
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
        <button onClick={load} className="text-sm px-3 py-1 rounded border hover:bg-gray-50">
          Обновить
        </button>
      </div>

      <p className="text-sm text-gray-500">
        Параллельный слой сигналов поверх находок стадий 1–4. Только для отладки новой
        архитектуры анализа — не влияет на рецензию и экспорт.
      </p>

      <div className="flex gap-2 flex-wrap">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={clsx(
              'text-sm px-3 py-1 rounded border',
              filter === f ? 'bg-gray-900 text-white border-gray-900' : 'hover:bg-gray-50',
            )}
          >
            {f === 'all' ? 'Все' : TYPE_LABEL[f]}
            {f !== 'all' && byType[f] ? ` · ${byType[f]}` : ''}
          </button>
        ))}
      </div>

      {loading && <div className="text-gray-500">Загрузка…</div>}

      {!loading && !items.length && (
        <div className="text-gray-500">
          Сигналов нет. Запустите стадии 1–4 для этого тендера, затем обновите.
        </div>
      )}

      {!loading && !!items.length && (
        <div className="text-sm text-gray-600">Всего: {items.length}</div>
      )}

      <div className="space-y-3">
        {items.map((s) => (
          <div key={s.id} className="border rounded p-3 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={clsx('text-xs px-2 py-0.5 rounded', TYPE_CLASS[s.signal_type] || 'bg-gray-100 text-gray-700')}>
                {TYPE_LABEL[s.signal_type] || s.signal_type}
              </span>
              <span className="text-xs text-gray-500">стадия {s.analysis_stage}</span>
              <span className="text-xs text-gray-500">вес {Number(s.weight).toFixed(2)}</span>
              {s.tz_clause && <span className="text-xs text-gray-400 truncate max-w-md">{s.tz_clause}</span>}
            </div>
            {s.source_fragment && (
              <div className="text-sm text-gray-800 whitespace-pre-wrap line-clamp-3">
                «{s.source_fragment}»
              </div>
            )}
            {s.signal_payload && (
              <pre className="text-xs bg-gray-50 rounded p-2 overflow-x-auto">
                {JSON.stringify(s.signal_payload, null, 2)}
              </pre>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
