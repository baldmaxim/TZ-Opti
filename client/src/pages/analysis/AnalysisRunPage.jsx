import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../services/api';
import { toastError } from '../../store/useToastStore';
import { useTenderStore } from '../../store/useTenderStore';
import { withViewTransition } from '../../utils/viewTransition';
import ClusterList from '../../components/clusters/ClusterList';
import SelfAnalysisFindings from '../../components/selfAnalysis/SelfAnalysisFindings';

// Страница «Анализ ТЗ»: одна кнопка «Начать анализ» → агент прогоняет добытчиков
// стадий 1–4 + самоанализ (store.runAnalysis) → по завершении показываются замечания
// (кластеры) и блок самоанализа, плюс переходы на Рецензию и Экспорт. Если анализ
// уже собран ранее — результат показывается сразу, без повторного прогона.

export default function AnalysisRunPage() {
  const tender = useTenderStore((s) => s.tender);
  const tenderId = useTenderStore((s) => s.tenderId);
  const runAnalysis = useTenderStore((s) => s.runAnalysis);
  const analysisRunning = useTenderStore((s) => s.analysisRunning);
  const analysisStep = useTenderStore((s) => s.analysisStep);
  const navigate = useNavigate();

  const [clusters, setClusters] = useState([]);
  const [selfAnalysis, setSelfAnalysis] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [ranOnce, setRanOnce] = useState(false);

  const load = async () => {
    if (!tenderId) return;
    try {
      const [cl, sa] = await Promise.all([
        api.listClusters(tenderId, 'working'),
        api.listSelfAnalysis(tenderId).catch(() => ({ items: [] })),
      ]);
      setClusters(cl.items || []);
      setSelfAnalysis(sa.items || []);
      setLoaded(true);
    } catch (err) { toastError(err.message); setLoaded(true); }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [tenderId]);

  const onStart = async () => {
    const res = await runAnalysis({ withSelfAnalysis: true });
    if (res?.ok) {
      setRanOnce(true);
      await load();
    }
  };

  if (!tender || !tenderId) return null;

  const goOverview = () => withViewTransition('back', () => navigate(`/tenders/${tenderId}`));
  const hasResults = clusters.length > 0;

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

      {/* Стартовый/прогон-блок: единственная кнопка запуска анализа. */}
      {!hasResults ? (
        <div className="bg-white border border-gray-200 rounded-lg p-10 flex flex-col items-center text-center">
          <h2 className="text-lg font-semibold text-gray-900">Анализ технического задания</h2>
          <p className="text-sm text-gray-600 mt-2 max-w-xl">
            Агент проверит ТЗ по всем направлениям (покрытие расчёта, Q&A и характеристики,
            существенные условия, типовые риски) и проведёт самоанализ итога. По завершении
            ниже появятся найденные замечания.
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
          {!analysisRunning && !ranOnce && loaded && (
            <p className="text-xs text-gray-400 mt-3">Замечаний пока нет — запустите анализ.</p>
          )}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-lg font-semibold">Найденные замечания</h2>
              <p className="text-sm text-gray-600 mt-0.5">
                Замечания сгруппированы по местам ТЗ (кластеры). Решения принимаются на экране «Рецензия».
              </p>
            </div>
            <button
              type="button"
              onClick={onStart}
              disabled={analysisRunning}
              className="btn btn-secondary text-sm"
            >
              {analysisRunning ? (analysisStep || 'Анализ…') : 'Перезапустить анализ'}
            </button>
          </div>

          <ClusterList items={clusters} />

          <div className="space-y-2">
            <h3 className="text-base font-semibold">Самоанализ</h3>
            {selfAnalysis.length > 0 ? (
              <SelfAnalysisFindings items={selfAnalysis} />
            ) : (
              <p className="text-sm text-gray-500">Самоанализ не выявил дополнительных замечаний по итогу разбора.</p>
            )}
          </div>

          <div className="flex flex-wrap gap-3 pt-2 border-t">
            <button
              type="button"
              onClick={() => navigate(`/tenders/${tenderId}/review`)}
              className="btn btn-primary"
            >
              Перейти к рецензии →
            </button>
            <button
              type="button"
              onClick={() => navigate(`/tenders/${tenderId}/export`)}
              className="btn btn-secondary"
            >
              Экспорт
            </button>
          </div>
        </>
      )}
    </div>
  );
}
