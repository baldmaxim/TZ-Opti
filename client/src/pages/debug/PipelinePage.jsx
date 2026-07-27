import { useEffect, useState } from 'react';
import { api } from '../../services/api';
import { toastError, toastSuccess, toastWarning } from '../../store/useToastStore';
import { useTenderStore } from '../../store/useTenderStore';

// Debug-вкладка оркестратора конвейера: свежесть слоёв (signals → draft_issues →
// critic → clustering → self-analysis) + пересборка всей цепочки одной кнопкой.
// /tenders/:id/debug/pipeline

const STEP_STATUS_CLASS = {
  done: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300',
  failed: 'bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-300',
  skipped: 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400',
};

const STEP_STATUS_LABEL = {
  done: 'выполнен',
  failed: 'сбой',
  skipped: 'пропущен',
};

function fmtBuiltAt(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('ru-RU'); } catch (_e) { return iso; }
}

export default function PipelinePage() {
  const tenderId = useTenderStore((s) => s.tenderId);
  const [status, setStatus] = useState(null);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [withSelfAnalysis, setWithSelfAnalysis] = useState(true);

  const load = async () => {
    if (!tenderId) return;
    setLoading(true);
    try {
      setStatus(await api.getPipelineStatus(tenderId));
    } catch (err) { toastError(err.message); }
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [tenderId]);

  // mode: 'production' — полная сборка (требует валидный набор входов, переводит
  // указатель) либо 'debug' — ЧАСТИЧНАЯ сборка: считает слои из того, что есть, но
  // основной указатель не двигает (портал продолжает читать прежний снимок).
  const run = async (mode = 'production') => {
    if (!tenderId) return;
    setRunning(true);
    setReport(null);
    try {
      const res = await api.runPipeline(tenderId, { withSelfAnalysis, mode });
      setReport(res);
      if (res.blocked === 'inputs') {
        toastError(`Входы конвейера не годятся: ${res.error || 'см. отчёт'}`);
      } else if (res.stale_inputs) {
        toastError('Снимок не активирован: входы изменились во время сборки (stale).');
      } else if (res.ok && res.activated === false) {
        toastWarning(`Debug-сборка: ${res.steps_done}/${res.steps_total} шагов, указатель НЕ переведён.`);
      } else if (res.ok) {
        toastSuccess(`Конвейер пересобран: ${res.steps_done}/${res.steps_total} шагов`);
      } else {
        toastError(`Конвейер: сбой на шаге «${res.failed_step}» (${res.steps_done}/${res.steps_total})`);
      }
      await load();
    } catch (err) { toastError(err.message); }
    setRunning(false);
  };

  const layers = (status && status.layers) || [];

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Конвейер анализа — оркестратор (debug)</h1>
        <div className="flex items-center gap-3">
          <label className="text-sm text-gray-600 dark:text-gray-400 flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={withSelfAnalysis}
              onChange={(e) => setWithSelfAnalysis(e.target.checked)}
            />
            включая self-analysis (LLM)
          </label>
          <button onClick={load} className="text-sm px-3 py-1 rounded border dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800">
            Обновить
          </button>
          <button
            onClick={() => run('debug')}
            disabled={running}
            title="Частичная сборка из того, что есть. Основной указатель НЕ переводится."
            className="text-sm px-3 py-1 rounded border border-amber-400 text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-900/30 disabled:opacity-50"
          >
            Debug-сборка (без активации)
          </button>
          <button
            onClick={() => run('production')}
            disabled={running}
            className="text-sm px-3 py-1 rounded bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-50"
          >
            {running ? 'Пересборка…' : 'Пересобрать конвейер'}
          </button>
        </div>
      </div>

      <p className="text-sm text-gray-500 dark:text-gray-400">
        Один вызов вместо четырёх POST: draft_issues → critic → clustering → self-analysis.
        Слои зависят друг от друга (каскадная чистка при пересборке родителя), поэтому порядок
        фиксирован, а после сбоя шага остальные пропускаются. Сигналы конвейер не пересоздаёт —
        их пишут стадии 1–4. Сборка привязана к ТОЧНОМУ набору stage-прогонов (manifest: стадия +
        run_id + ревизия документов + версия конфигурации + статус): он проверяется до шагов и
        ещё раз перед активацией, поэтому неполный/разноревизионный набор к production-сборке не
        допускается, а если во время сборки сдвинулся указатель стадии — снимок не активируется.
        Debug-сборка допускает частичный набор, но основной указатель не двигает.
      </p>

      {/* Свежесть слоёв */}
      {loading && <div className="text-gray-500 dark:text-gray-400">Загрузка…</div>}

      {!loading && status && (
        <div className="border dark:border-gray-700 rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800 text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
              <tr>
                <th className="px-4 py-2">Слой</th>
                <th className="px-4 py-2">Записей</th>
                <th className="px-4 py-2">Собран</th>
                <th className="px-4 py-2">Состояние</th>
              </tr>
            </thead>
            <tbody>
              {layers.map((l) => (
                <tr key={l.key} className="border-t dark:border-gray-700">
                  <td className="px-4 py-2">{l.label}</td>
                  <td className="px-4 py-2">{l.count}</td>
                  <td className="px-4 py-2 text-gray-500 dark:text-gray-400">{fmtBuiltAt(l.built_at)}</td>
                  <td className="px-4 py-2">
                    {l.stale ? (
                      <span className="text-xs px-2 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300">
                        требует пересборки
                      </span>
                    ) : l.empty ? (
                      <span className="text-xs px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400">пусто</span>
                    ) : (
                      <span className="text-xs px-2 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300">актуален</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && status && (
        <div className="text-sm text-gray-600 dark:text-gray-400">
          {status.needs_rebuild
            ? 'Есть устаревшие слои — нажмите «Пересобрать конвейер».'
            : 'Все слои согласованы.'}
        </div>
      )}

      {/* Отчёт последнего прогона */}
      {report && (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Отчёт прогона</h2>

          {/* Входы прогона (manifest stage-прогонов) и судьба указателя */}
          <div className="border dark:border-gray-700 rounded p-3 space-y-1 text-sm">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                режим: {report.mode || 'production'}
              </span>
              <span className={`text-xs px-2 py-0.5 rounded ${report.activated
                ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300'
                : 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300'}`}
              >
                {report.activated ? 'указатель переведён' : 'указатель НЕ переведён'}
              </span>
              {report.run_id && (
                <span className="text-xs text-gray-400 dark:text-gray-500 font-mono">{report.run_id}</span>
              )}
            </div>
            {report.error && <div className="text-red-700 dark:text-red-300">{report.error}</div>}
            {report.inputs && report.inputs.violations && (
              <ul className="list-disc pl-5 text-xs text-amber-800 dark:text-amber-300">
                {report.inputs.violations.map((v, i) => (
                  <li key={`${v.code}-${v.stage ?? 'run'}-${i}`}>
                    <span className="font-mono">{v.code}</span>
                    {v.stage ? ` (стадия ${v.stage})` : ''}: {v.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {report.steps.map((s) => (
            <div key={s.step} className="border dark:border-gray-700 rounded p-3 space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`text-xs px-2 py-0.5 rounded font-medium ${STEP_STATUS_CLASS[s.status] || ''}`}>
                  {STEP_STATUS_LABEL[s.status] || s.status}
                </span>
                <span className="text-sm text-gray-800 dark:text-gray-100">{s.label}</span>
                {typeof s.ms === 'number' && <span className="text-xs text-gray-400 dark:text-gray-500">{s.ms} мс</span>}
              </div>
              {s.error && <div className="text-sm text-red-700 dark:text-red-300">{s.error}</div>}
              {s.reason && <div className="text-sm text-gray-500 dark:text-gray-400">{s.reason}</div>}
              {s.summary && (
                <div className="text-xs text-gray-500 dark:text-gray-400 font-mono whitespace-pre-wrap">
                  {Object.entries(s.summary)
                    .map(([k, v]) => `${k}: ${typeof v === 'object' && v !== null ? JSON.stringify(v) : v}`)
                    .join(' · ')}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
