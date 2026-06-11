import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../services/api';
import { toastError } from '../../store/useToastStore';
import { useTenderStore } from '../../store/useTenderStore';
import { withViewTransition } from '../../utils/viewTransition';

// Страница «Анализ ТЗ» — лаунчер анализа. Одна кнопка «Начать анализ» → агент
// прогоняет добытчиков стадий 1–4 + самоанализ (store.runAnalysis). По завершении
// пользователь сразу попадает на «Рецензию», где замечания редактируемы (решения
// по кластерам + правка редакции/комментария, самоанализ внутри карточек). Сам
// список замечаний здесь не показывается — это шаг запуска, а не просмотра.

export default function AnalysisRunPage() {
  const tender = useTenderStore((s) => s.tender);
  const tenderId = useTenderStore((s) => s.tenderId);
  const runAnalysis = useTenderStore((s) => s.runAnalysis);
  const analysisRunning = useTenderStore((s) => s.analysisRunning);
  const analysisStep = useTenderStore((s) => s.analysisStep);
  const navigate = useNavigate();

  const [clusterCount, setClusterCount] = useState(null); // null = ещё не загружено
  const [ranOnce, setRanOnce] = useState(false);

  // Грузим только факт наличия замечаний (кластеров) — список здесь не нужен.
  const loadCount = async () => {
    if (!tenderId) return 0;
    try {
      const res = await api.listClusters(tenderId, 'working');
      const n = (res.items || []).length;
      setClusterCount(n);
      return n;
    } catch (err) { toastError(err.message); setClusterCount(0); return 0; }
  };

  useEffect(() => { loadCount(); /* eslint-disable-next-line */ }, [tenderId]);

  const goReview = () => navigate(`/tenders/${tenderId}/review`);

  const onStart = async () => {
    const res = await runAnalysis({ withSelfAnalysis: true });
    if (!res?.ok) return;
    setRanOnce(true);
    const n = await loadCount();
    if (n > 0) goReview(); // сразу на «Рецензию» — там замечания редактируемы
  };

  if (!tender || !tenderId) return null;

  const goOverview = () => withViewTransition('back', () => navigate(`/tenders/${tenderId}`));
  const hasResults = clusterCount != null && clusterCount > 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={goOverview}
          className="inline-flex items-center gap-3 px-7 py-4 rounded-lg text-base font-medium bg-gray-600 text-white hover:bg-gray-500 transition"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 14 4 9l5-5" />
            <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
          </svg>
          К обзору
        </button>
        <h1 className="flex-1 text-center text-lg font-semibold text-gray-900 truncate min-w-0 px-2" title={tender.title}>
          Анализ ТЗ — {tender.title}
        </h1>
        <span aria-hidden="true" className="invisible inline-flex items-center gap-3 px-7 py-4 text-base font-medium">
          К обзору
        </span>
      </div>

      <div className="bg-white border border-gray-200 rounded-lg p-10 flex flex-col items-center text-center">
        {hasResults ? (
          <>
            <h2 className="text-lg font-semibold text-gray-900">Анализ выполнен</h2>
            <p className="text-sm text-gray-600 mt-2 max-w-xl">
              Найдено замечаний (кластеров): <strong>{clusterCount}</strong>. Перейдите к рецензии,
              чтобы принять решения по каждому замечанию, или перезапустите анализ заново.
            </p>
            <div className="flex flex-wrap gap-3 justify-center mt-6">
              <button type="button" onClick={goReview} className="btn btn-primary px-8 py-3 text-base">
                Перейти к рецензии →
              </button>
              <button
                type="button"
                onClick={onStart}
                disabled={analysisRunning}
                className="btn btn-secondary px-6 py-3 text-base"
              >
                {analysisRunning ? (analysisStep || 'Анализ…') : 'Перезапустить анализ'}
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 className="text-lg font-semibold text-gray-900">Анализ технического задания</h2>
            <p className="text-sm text-gray-600 mt-2 max-w-xl">
              Агент проверит ТЗ по всем направлениям (покрытие расчёта, Q&A и характеристики,
              существенные условия, типовые риски) и проведёт самоанализ итога. По завершении
              откроется «Рецензия» с найденными замечаниями.
            </p>
            <button
              type="button"
              onClick={onStart}
              disabled={analysisRunning}
              className="btn btn-primary mt-6 px-8 py-3 text-base"
            >
              {analysisRunning ? (analysisStep || 'Анализ выполняется…') : 'Начать анализ'}
            </button>
            {analysisRunning && (
              <p className="text-xs text-gray-500 mt-3">
                Анализ идёт в фоне и может занять несколько минут. Не закрывайте вкладку.
              </p>
            )}
            {!analysisRunning && ranOnce && (
              <p className="text-sm text-emerald-700 mt-4 inline-block bg-emerald-50 border border-emerald-200 rounded px-3 py-2">
                ✓ Анализ завершён — замечаний не найдено.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
