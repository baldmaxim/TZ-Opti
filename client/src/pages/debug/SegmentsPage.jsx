import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { api } from '../../services/api';
import { toastError, toastSuccess } from '../../store/useToastStore';
import { useTenderStore } from '../../store/useTenderStore';
import { stageTitle } from '../../utils/labels';

// Debug-вкладка нарезки ТЗ на части (иерархическая token-aware сегментация).
// Большое ТЗ анализируется по частям: здесь видно, как документ нарезан, какая
// часть посчитана, какая упала и почему, и можно пересчитать ОДНУ часть —
// остальные стадия возьмёт из сохранённых результатов.
// Доступна по /tenders/:id/debug/segments (в основной wizard-сайдбар не входит).

const STAGES = [1, 2, 3, 4, 5];

const STATUS_LABEL = {
  pending: 'В очереди',
  running: 'Считается',
  completed: 'Готово',
  failed: 'Ошибка',
};

const STATUS_CLASS = {
  pending: 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300',
  running: 'bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-300',
  completed: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-300',
  failed: 'bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-300',
};

export default function SegmentsPage() {
  const tenderId = useTenderStore((s) => s.tenderId);
  const [stage, setStage] = useState(1);
  const [items, setItems] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(null);

  const load = async () => {
    if (!tenderId) return;
    setLoading(true);
    try {
      const res = await api.listStageSegments(tenderId, stage);
      setItems(res.items || []);
      setSummary(res.summary || null);
    } catch (err) { toastError(err.message); }
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [tenderId, stage]);

  const retry = async (idx) => {
    setRetrying(idx);
    try {
      await api.retryStageSegment(tenderId, stage, idx);
      toastSuccess(`Часть ${idx + 1} поставлена на пересчёт — остальные части возьмутся из сохранённых.`);
      await load();
    } catch (err) { toastError(err.message); }
    setRetrying(null);
  };

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Части ТЗ (debug)</h1>
        <button onClick={load} className="text-sm px-3 py-1 rounded border dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800">
          Обновить
        </button>
      </div>

      <p className="text-sm text-gray-500 dark:text-gray-400">
        Большое ТЗ анализируется по частям: деление идёт по разделам и пунктам, соседние
        части перекрываются (пункт на стыке читается целиком), слишком большой пункт
        дробится отдельно. Результат каждой части сохраняется — повтор стадии не
        переспрашивает модель про уже посчитанное, а упавшую часть можно пересчитать точечно.
      </p>

      <div className="flex gap-2 flex-wrap">
        {STAGES.map((n) => (
          <button
            key={n}
            onClick={() => setStage(n)}
            className={clsx(
              'text-sm px-3 py-1 rounded border dark:border-gray-700',
              stage === n ? 'bg-gray-900 text-white border-gray-900' : 'hover:bg-gray-50 dark:hover:bg-gray-800',
            )}
          >
            {stageTitle(n)}
          </button>
        ))}
      </div>

      {loading && <div className="text-gray-500 dark:text-gray-400">Загрузка…</div>}

      {!loading && !items.length && (
        <div className="text-gray-500 dark:text-gray-400">
          Частей нет: стадия ещё не запускалась. Нарезка создаётся при первом прогоне.
        </div>
      )}

      {!loading && !!summary && !!items.length && (
        <div className="text-sm text-gray-600 dark:text-gray-400">
          Частей: {summary.total} · готово: {summary.completed} · с ошибкой: {summary.failed} ·
          {' '}находок: {summary.findings}
        </div>
      )}

      {!loading && !!items.length && (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-left text-gray-500 dark:text-gray-400">
              <tr>
                <th className="py-2 pr-3">#</th>
                <th className="py-2 pr-3">Раздел ТЗ</th>
                <th className="py-2 pr-3">Блоки</th>
                <th className="py-2 pr-3">Размер</th>
                <th className="py-2 pr-3">Статус</th>
                <th className="py-2 pr-3">Попыток</th>
                <th className="py-2 pr-3">Находок</th>
                <th className="py-2 pr-3" />
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id} className="border-t dark:border-gray-700 align-top">
                  <td className="py-2 pr-3 whitespace-nowrap">
                    {s.segment_index + 1}/{s.segment_total || items.length}
                  </td>
                  <td className="py-2 pr-3 max-w-md">
                    <div className="truncate">{s.heading_path || '—'}</div>
                    {s.error && (
                      <div className="text-xs text-red-600 dark:text-red-400 whitespace-pre-wrap">{s.error}</div>
                    )}
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap text-gray-500 dark:text-gray-400">
                    {s.first_block_index}…{s.last_block_index}
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap text-gray-500 dark:text-gray-400">
                    ≈{Number(s.tokens_estimate || 0).toLocaleString('ru-RU')} т
                    <span className="text-xs"> / {Number(s.chars || 0).toLocaleString('ru-RU')} симв</span>
                  </td>
                  <td className="py-2 pr-3">
                    <span className={clsx('text-xs px-2 py-0.5 rounded whitespace-nowrap', STATUS_CLASS[s.status] || STATUS_CLASS.pending)}>
                      {STATUS_LABEL[s.status] || s.status}
                    </span>
                  </td>
                  <td className="py-2 pr-3">{s.attempts}</td>
                  <td className="py-2 pr-3">{s.findings_count}</td>
                  <td className="py-2 pr-3">
                    <button
                      onClick={() => retry(s.segment_index)}
                      disabled={retrying !== null}
                      className="text-xs px-2 py-1 rounded border dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
                    >
                      {retrying === s.segment_index ? 'Ставим…' : 'Пересчитать часть'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
