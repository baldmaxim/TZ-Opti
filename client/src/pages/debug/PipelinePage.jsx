import { useEffect, useState } from 'react';
import { api } from '../../services/api';
import { toastError, toastSuccess, toastWarning } from '../../store/useToastStore';
import { useTenderStore } from '../../store/useTenderStore';
import { ANALYSIS_STATUS, severityOf } from '../../utils/analysisResult';

// Debug-вкладка оркестратора конвейера: свежесть слоёв (signals → draft_issues →
// critic → clustering → self-analysis) + пересборка всей цепочки одной кнопкой.
// /tenders/:id/debug/pipeline
//
// Отчёт прогона НЕ живёт в памяти вкладки: исход целиком пишется в
// analysis_runs.summary при завершении и приходит обратно в /pipeline/status
// (last_run). Поэтому после перезагрузки страницы и рестарта сервера здесь виден
// тот же completed / completed_with_warnings / failed, что был зафиксирован.

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

const RUN_STATUS_LABEL = {
  [ANALYSIS_STATUS.COMPLETED]: 'успех',
  [ANALYSIS_STATUS.COMPLETED_WITH_WARNINGS]: 'частичный результат',
  [ANALYSIS_STATUS.FAILED]: 'сбой',
  [ANALYSIS_STATUS.CANCELLED]: 'отменён',
  [ANALYSIS_STATUS.INTERRUPTED]: 'оборван',
};

const SEVERITY_CLASS = {
  success: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300',
  warning: 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300',
  error: 'bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-300',
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
  // Свежий ответ прогона либо — после перезагрузки — исход, прочитанный из БД.
  // Формы совместимы, поэтому рисуются одним кодом.
  const shown = report || (status && status.last_run) || null;

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

      {/* Отчёт прогона: свежий либо сохранённый в analysis_runs.summary */}
      {shown && (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
            Отчёт прогона
            {!report && (
              <span className="ml-2 font-normal text-xs text-gray-500 dark:text-gray-400">
                — сохранённый исход последней сборки (из БД)
              </span>
            )}
          </h2>

          {/* Исход прогона, входы (manifest stage-прогонов) и судьба указателя */}
          <div className="border dark:border-gray-700 rounded p-3 space-y-1 text-sm">
            <div className="flex items-center gap-2 flex-wrap">
              {shown.status && (
                <span className={`text-xs px-2 py-0.5 rounded font-medium ${SEVERITY_CLASS[severityOf(shown.status)]}`}>
                  {RUN_STATUS_LABEL[shown.status] || shown.status}
                </span>
              )}
              <span className="text-xs px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                режим: {shown.mode || 'production'}
              </span>
              <span className={`text-xs px-2 py-0.5 rounded ${shown.activated
                ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300'
                : 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300'}`}
              >
                {shown.activated ? 'указатель переведён' : 'указатель НЕ переведён'}
              </span>
              {shown.failed_step && (
                <span className="text-xs px-2 py-0.5 rounded bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-300">
                  сбой на шаге «{shown.failed_step}»
                </span>
              )}
              {shown.run_id && (
                <span className="text-xs text-gray-400 dark:text-gray-500 font-mono">{shown.run_id}</span>
              )}
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400">
              начат: {fmtBuiltAt(shown.started_at)} · завершён: {fmtBuiltAt(shown.finished_at)}
            </div>
            {shown.error && <div className="text-red-700 dark:text-red-300">{shown.error}</div>}
            {/* Почему итог не зелёный: причины частичного результата */}
            {Array.isArray(shown.partial) && shown.partial.length > 0 && (
              <ul className="list-disc pl-5 text-xs text-amber-800 dark:text-amber-300">
                {shown.partial.map((p, i) => (
                  <li key={`${p.step}-${i}`}>шаг «{p.step}»: {p.reason}</li>
                ))}
              </ul>
            )}
            {shown.inputs && shown.inputs.violations && (
              <ul className="list-disc pl-5 text-xs text-amber-800 dark:text-amber-300">
                {shown.inputs.violations.map((v, i) => (
                  <li key={`${v.code}-${v.stage ?? 'run'}-${i}`}>
                    <span className="font-mono">{v.code}</span>
                    {v.stage ? ` (стадия ${v.stage})` : ''}: {v.message}
                  </li>
                ))}
              </ul>
            )}
            {/* Входные stage-прогоны: из какого именно снимка каждой стадии собран итог */}
            {Array.isArray(shown.stage_inputs) && shown.stage_inputs.length > 0 && (
              <div className="pt-1">
                <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Входные stage-прогоны</div>
                <table className="w-full text-xs mt-1">
                  <tbody>
                    {shown.stage_inputs.map((s) => (
                      <tr key={s.stage} className="border-t dark:border-gray-700">
                        <td className="py-1 pr-3">Стадия {s.stage}</td>
                        <td className="py-1 pr-3 font-mono text-gray-500 dark:text-gray-400">{s.analysis_run_id || '—'}</td>
                        <td className="py-1 pr-3">{s.status || '—'}</td>
                        <td className="py-1 pr-3 font-mono text-gray-400 dark:text-gray-500">{s.documents_revision_id || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          {(shown.steps || []).map((s) => (
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
