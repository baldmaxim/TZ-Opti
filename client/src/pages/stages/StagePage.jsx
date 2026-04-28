import { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../services/api';
import { useTenderStore } from '../../store/useTenderStore';
import { toastError } from '../../store/useToastStore';
import { useWizardState } from '../../hooks/useWizardState';
import { STAGE_CONFIG } from './stageConfig';
import StageRunControls from './StageRunControls';
import StageDecisionTable from '../../components/stages/StageDecisionTable';
import NextStepCta from '../../components/wizard/NextStepCta';
import GateNotice from '../../components/wizard/GateNotice';
import { STAGE_STATUS, criticalityClass } from '../../utils/labels';

export default function StagePage() {
  const { n } = useParams();
  const stage = Number(n);
  const tenderId = useTenderStore((s) => s.tenderId);
  const stages = useTenderStore((s) => s.stages);
  const refreshStages = useTenderStore((s) => s.refreshStages);
  const refreshTender = useTenderStore((s) => s.refreshTender);
  const { steps } = useWizardState();

  const stageStep = steps.find((s) => s.stage === stage);
  const config = STAGE_CONFIG[stage];

  const filterKey = useMemo(
    () => `tz-opti.tender:${tenderId}.stage:${stage}.filter`,
    [tenderId, stage]
  );
  const [filter, setFilter] = useState(() => {
    try {
      const saved = sessionStorage.getItem(filterKey);
      return saved ? JSON.parse(saved) : { criticality: '', review_status: '' };
    } catch {
      return { criticality: '', review_status: '' };
    }
  });

  const [issues, setIssues] = useState([]);
  const [loadingIssues, setLoadingIssues] = useState(false);

  useEffect(() => {
    try { sessionStorage.setItem(filterKey, JSON.stringify(filter)); } catch { /* ignore */ }
  }, [filter, filterKey]);

  const stageInfo = stages?.find((s) => s.stage === stage);
  const status = stageInfo?.status;
  const summary = stageInfo?.summary?.summary;
  const isReadOnly = status === 'finished';

  const loadIssues = useCallback(async () => {
    if (!tenderId) return;
    if (stageStep?.status === 'locked') return;
    setLoadingIssues(true);
    try {
      const params = {};
      if (filter.criticality) params.criticality = filter.criticality;
      if (filter.review_status) params.review_status = filter.review_status;
      const data = await api.listStageIssues(tenderId, stage, params);
      setIssues(data.items || []);
    } catch (err) { toastError(err.message); }
    setLoadingIssues(false);
  }, [tenderId, stage, filter.criticality, filter.review_status, stageStep?.status]);

  useEffect(() => { loadIssues(); }, [loadIssues]);

  if (!stageStep || !config) return null;

  if (stageStep.status === 'locked') {
    return <GateNotice stepId={stageStep.id} />;
  }

  const counts = summary?.by_criticality || {};
  const ContextSlot = config.ContextSlot;

  const pendingCount = issues.filter((i) => i.review_status === 'pending').length;
  const allDecided = summary && pendingCount === 0;
  const ctaDisabled = !isReadOnly && (!summary || !allDecided);
  const ctaDisabledHint = !summary
    ? 'Запустите анализ для этой стадии.'
    : `Сначала примите решения по ${pendingCount} замечаниям.`;

  return (
    <div className="space-y-4">
      <div className="card p-4">
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div>
            <h2 className="font-semibold text-lg">{config.label}</h2>
            <p className="text-sm text-gray-600 mt-1">{config.description}</p>
            <p className="text-xs text-gray-500 mt-2">Статус: {STAGE_STATUS[status] || status}</p>
            {summary && (
              <div className="text-xs text-gray-600 mt-2">
                Замечаний: <strong>{summary.issues_count}</strong>
                {' '}{Object.entries(counts).map(([k, v]) => (
                  <span key={k} className={`tag ml-1 ${criticalityClass(k)}`}>{k}: {v}</span>
                ))}
              </div>
            )}
          </div>
          <StageRunControls stage={stage} status={status} hasSummary={!!summary} />
        </div>

        {ContextSlot && tenderId && <ContextSlot tenderId={tenderId} />}
      </div>

      {summary && (
        <div className="flex items-center gap-3 flex-wrap">
          <div className="text-sm text-gray-600">Фильтры:</div>
          <select
            className="input max-w-[200px]"
            value={filter.criticality}
            onChange={(e) => setFilter((f) => ({ ...f, criticality: e.target.value }))}
          >
            <option value="">Любая критичность</option>
            <option value="low">Низкая</option>
            <option value="medium">Средняя</option>
            <option value="high">Высокая</option>
            <option value="critical">Критическая</option>
          </select>
          <select
            className="input max-w-[200px]"
            value={filter.review_status}
            onChange={(e) => setFilter((f) => ({ ...f, review_status: e.target.value }))}
          >
            <option value="">Любой статус</option>
            <option value="pending">На рассмотрении</option>
            <option value="accepted">Принято</option>
            <option value="rejected">Отклонено</option>
            <option value="edited">Отредактировано</option>
          </select>
          {(filter.criticality || filter.review_status) && (
            <button
              className="btn btn-ghost text-xs"
              onClick={() => setFilter({ criticality: '', review_status: '' })}
            >Сбросить фильтры</button>
          )}
        </div>
      )}

      {loadingIssues ? (
        <div className="text-center py-6 text-gray-500">Загрузка замечаний…</div>
      ) : (
        <StageDecisionTable
          issues={issues}
          readOnly={isReadOnly}
          onChanged={async () => {
            await loadIssues();
            await refreshStages();
            await refreshTender();
          }}
        />
      )}

      <NextStepCta disabled={ctaDisabled} disabledHint={ctaDisabledHint} />
    </div>
  );
}
