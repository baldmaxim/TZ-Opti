import { useEffect, useState, useCallback } from 'react';
import { api } from '../../services/api';
import { STAGE_LABELS, STAGE_STATUS, criticalityClass } from '../../utils/labels';
import { toastError, toastSuccess } from '../../store/useToastStore';
import { useTenderStore } from '../../store/useTenderStore';
import StageStepper from '../../components/stages/StageStepper';
import StageDecisionTable from '../../components/stages/StageDecisionTable';
import ResetStageModal from '../../components/stages/ResetStageModal';
import Stage2Card from './stages/Stage2Card';

export default function StagesTab({ tenderId }) {
  const stages = useTenderStore((s) => s.stages);
  const stageState = useTenderStore((s) => s.stageState);
  const refreshStages = useTenderStore((s) => s.refreshStages);
  const refreshTender = useTenderStore((s) => s.refreshTender);

  const [activeStage, setActiveStage] = useState(1);
  const [issues, setIssues] = useState([]);
  const [busy, setBusy] = useState(false);
  const [resetTo, setResetTo] = useState(null);
  const [resetting, setResetting] = useState(false);
  const [filter, setFilter] = useState({ criticality: '', review_status: '' });

  useEffect(() => {
    if (stages && !stages.find((s) => s.stage === activeStage)) {
      setActiveStage(stages[0]?.stage || 1);
    }
  }, [stages]);

  useEffect(() => {
    if (stageState?.current_stage) setActiveStage(stageState.current_stage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageState?.current_stage]);

  const loadIssues = useCallback(async () => {
    try {
      const params = {};
      if (filter.criticality) params.criticality = filter.criticality;
      if (filter.review_status) params.review_status = filter.review_status;
      const data = await api.listStageIssues(tenderId, activeStage, params);
      setIssues(data.items || []);
    } catch (err) { toastError(err.message); }
  }, [tenderId, activeStage, filter.criticality, filter.review_status]);

  useEffect(() => { loadIssues(); }, [loadIssues]);

  const stageInfo = stages?.find((s) => s.stage === activeStage);
  const status = stageInfo?.status;
  const isReadOnly = status === 'finished';

  const runAnalysis = async () => {
    setBusy(true);
    try {
      await api.runStage(tenderId, activeStage);
      toastSuccess('Анализ выполнен');
      await refreshStages();
      await loadIssues();
    } catch (err) { toastError(err.message); }
    setBusy(false);
  };

  const finishStage = async () => {
    if (!confirm('Завершить стадию? Решения с действием "удалить из ТЗ" будут применены к активному тексту, и стадия N+1 разблокируется.')) return;
    setBusy(true);
    try {
      await api.finishStage(tenderId, activeStage);
      toastSuccess(`Стадия ${activeStage} завершена`);
      await refreshStages();
      await refreshTender();
    } catch (err) { toastError(err.message); }
    setBusy(false);
  };

  const resetStage = async () => {
    setResetting(true);
    try {
      await api.resetStage(tenderId, resetTo);
      toastSuccess(`Сброс стадий ${resetTo}+ выполнен`);
      setActiveStage(resetTo);
      await refreshStages();
      await loadIssues();
    } catch (err) { toastError(err.message); }
    setResetting(false);
    setResetTo(null);
  };

  if (!stages) return <div className="text-gray-500">Загрузка состояния стадий…</div>;

  const summary = stageInfo?.summary?.summary;
  const counts = summary?.by_criticality || {};

  return (
    <div className="space-y-4">
      <StageStepper stages={stages} activeStage={activeStage} onChange={setActiveStage} />

      <div className="card p-4">
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div>
            <h3 className="font-semibold text-lg">Стадия {activeStage}: {STAGE_LABELS[activeStage]}</h3>
            <p className="text-xs text-gray-500 mt-1">Статус: {STAGE_STATUS[status] || status}</p>
            {summary && (
              <div className="text-xs text-gray-600 mt-2">
                Замечаний: <strong>{summary.issues_count}</strong> •
                {' '}{Object.entries(counts).map(([k, v]) => (
                  <span key={k} className={`tag mr-1 ${criticalityClass(k)}`}>{k}: {v}</span>
                ))}
              </div>
            )}
          </div>
          <div className="flex gap-2 flex-wrap">
            {!isReadOnly && status !== 'locked' && (
              <button className="btn btn-primary" onClick={runAnalysis} disabled={busy}>
                {busy ? 'Анализ…' : (summary ? 'Перезапустить анализ' : 'Запустить анализ')}
              </button>
            )}
            {!isReadOnly && status !== 'locked' && summary && (
              <button className="btn btn-secondary" onClick={finishStage} disabled={busy}>Завершить стадию</button>
            )}
            {isReadOnly && (
              <button className="btn btn-secondary" onClick={() => setResetTo(activeStage)}>Вернуться и пересмотреть</button>
            )}
          </div>
        </div>

        {activeStage === 2 && (
          <div className="mt-4">
            <Stage2Card />
          </div>
        )}

        {status === 'locked' && (
          <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded p-3 mt-3">
            Стадия заблокирована. Завершите предыдущую стадию, чтобы продолжить.
          </p>
        )}
      </div>

      {summary && (
        <div className="flex items-center gap-3 flex-wrap">
          <div className="text-sm text-gray-600">Фильтры:</div>
          <select className="input max-w-[200px]" value={filter.criticality} onChange={(e) => setFilter({ ...filter, criticality: e.target.value })}>
            <option value="">Любая критичность</option>
            <option value="low">Низкая</option>
            <option value="medium">Средняя</option>
            <option value="high">Высокая</option>
            <option value="critical">Критическая</option>
          </select>
          <select className="input max-w-[200px]" value={filter.review_status} onChange={(e) => setFilter({ ...filter, review_status: e.target.value })}>
            <option value="">Любой статус</option>
            <option value="pending">На рассмотрении</option>
            <option value="accepted">Принято</option>
            <option value="rejected">Отклонено</option>
            <option value="edited">Отредактировано</option>
          </select>
        </div>
      )}

      <StageDecisionTable
        issues={issues}
        readOnly={isReadOnly}
        onChanged={async () => { await loadIssues(); await refreshStages(); }}
      />

      <ResetStageModal
        open={resetTo !== null}
        stage={resetTo}
        busy={resetting}
        onClose={() => setResetTo(null)}
        onConfirm={resetStage}
      />
    </div>
  );
}
