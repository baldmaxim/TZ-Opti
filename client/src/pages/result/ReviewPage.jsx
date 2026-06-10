import { useEffect, useState } from 'react';
import { api } from '../../services/api';
import { criticalityClass, CRITICALITY, DECISIONS, formatProblemType } from '../../utils/labels';
import { toastError, toastSuccess } from '../../store/useToastStore';
import EmptyState from '../../components/ui/EmptyState';
import { useTenderStore } from '../../store/useTenderStore';
import { useWizardState } from '../../hooks/useWizardState';
import GateNotice from '../../components/wizard/GateNotice';

// Что именно ляжет в Word по выбранному решению (зеркало server/review/decisionModel.js).
const EXPORT_HINT = {
  accept: 'Примечание — Word-комментарий',
  edit: 'Замена — Track Changes (w:del + w:ins)',
  delete: 'Удаление — Track Changes (w:del)',
  remove_from_scope: 'Удаление + метка «Вынесено из объёма»',
  reject: 'Не экспортируется',
};

const FINDING_LABEL = {
  missed_coverage: 'Возможный пропуск',
  weak_cluster: 'Слабый кластер',
  cluster_contradiction: 'Противоречие кластеров',
  needs_enrichment: 'Можно усилить',
};

function ClusterCard({ cluster, onDecide }) {
  const decided = cluster.decision || null;
  const [red, setRed] = useState(decided?.edited_redaction ?? cluster.merged_recommendation ?? '');
  const [com, setCom] = useState(decided?.final_comment ?? '');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const decide = async (decision) => {
    setBusy(true);
    try {
      await onDecide(cluster.id, { decision, edited_redaction: red, final_comment: com });
    } finally {
      setBusy(false);
    }
  };

  const items = cluster.items || [];
  const notes = cluster.self_analysis || [];

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <span className={`tag ${criticalityClass(cluster.overall_criticality)}`}>
          {CRITICALITY[cluster.overall_criticality] || cluster.overall_criticality}
        </span>
        <span className="font-semibold text-sm">{cluster.cluster_title}</span>
        {!cluster.show_to_engineer && (
          <span className="tag bg-gray-100 text-gray-500 text-xs">малозначимо</span>
        )}
        <span className="tag bg-gray-100 text-gray-700 text-xs">
          {items.length} {items.length === 1 ? 'основание' : 'оснований'}
        </span>
        {decided && (
          <span className="tag bg-green-100 text-green-800 text-xs">
            Решение: {DECISIONS[decided.decision] || decided.decision}
          </span>
        )}
      </div>

      {cluster.tz_clause && (
        <div className="text-xs text-gray-600 mb-2">Пункт ТЗ: <strong>{cluster.tz_clause}</strong></div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <div className="label">Объединённое основание</div>
          <div className="p-3 bg-gray-50 border rounded text-sm whitespace-pre-wrap">
            {cluster.merged_basis || '—'}
          </div>

          <button
            type="button"
            className="text-xs text-brand-600 mt-2 hover:underline"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? '▾ Скрыть' : '▸ Показать'} исходные замечания и сигналы ({items.length})
          </button>
          {open && (
            <div className="mt-2 space-y-2">
              {items.map((it) => (
                <div key={it.draft_issue_id} className="text-xs border rounded p-2 bg-white">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`tag text-[10px] ${it.item_role === 'primary' ? 'bg-brand-100 text-brand-800' : 'bg-gray-100 text-gray-600'}`}>
                      {it.item_role === 'primary' ? 'основной' : 'связанный'}
                    </span>
                    {it.category && <span className="text-gray-500">[{it.category}]</span>}
                    {it.problem_type && <span className="text-gray-600">{formatProblemType(it.problem_type)}</span>}
                  </div>
                  {it.basis && <div className="text-gray-700">{it.basis}</div>}
                  {it.source_fragment && (
                    <div className="text-gray-500 mt-1 italic">«{it.source_fragment}»</div>
                  )}
                </div>
              ))}
            </div>
          )}

          {notes.length > 0 && (
            <div className="mt-3">
              <div className="label">Самоанализ (Стадия 5)</div>
              <div className="space-y-1">
                {notes.map((n) => (
                  <div key={n.id} className="text-xs p-2 rounded bg-amber-50 border border-amber-100">
                    <span className="font-medium text-amber-800">{FINDING_LABEL[n.finding_type] || n.finding_type}:</span>{' '}
                    <span className="text-gray-700">{n.comment}</span>
                    {n.suggested_improvement && (
                      <div className="text-gray-600 mt-0.5">→ {n.suggested_improvement}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div>
          <div className="label">Объединённая рекомендация / редакция</div>
          <textarea className="input min-h-[120px]" value={red} onChange={(e) => setRed(e.target.value)} />
          <div className="label mt-2">Комментарий для Word</div>
          <textarea className="input min-h-[70px]" value={com} onChange={(e) => setCom(e.target.value)} />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 justify-end">
        <button className="btn btn-secondary" disabled={busy} onClick={() => decide('reject')}>Отклонить</button>
        <button className="btn btn-secondary" disabled={busy} onClick={() => decide('edit')}>Принять с правкой</button>
        <button className="btn btn-primary" disabled={busy} onClick={() => decide('accept')}>Принять</button>
        <button className="btn btn-secondary" disabled={busy} onClick={() => decide('remove_from_scope')}>Вынести из объёма</button>
        <button className="btn btn-danger" disabled={busy} onClick={() => decide('delete')}>Удалить из ТЗ</button>
      </div>
      {decided && (
        <div className="text-xs text-gray-500 mt-2 text-right">
          В экспорт: {EXPORT_HINT[decided.decision] || '—'}
        </div>
      )}
    </div>
  );
}

export default function ReviewPage() {
  const tenderId = useTenderStore((s) => s.tenderId);
  const decideCluster = useTenderStore((s) => s.decideCluster);
  const { steps } = useWizardState();
  const reviewStep = steps.find((s) => s.id === 'review');

  const [clusters, setClusters] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [building, setBuilding] = useState(false);
  const [mode, setMode] = useState('working');

  const load = async (m = mode) => {
    if (!tenderId) return;
    try {
      const data = await api.listReviewClusters(tenderId, m);
      setClusters(data.items || []);
      setLoaded(true);
    } catch (err) { toastError(err.message); }
  };

  useEffect(() => {
    if (reviewStep?.status === 'locked') return;
    load();
    /* eslint-disable-next-line */
  }, [tenderId, reviewStep?.status]);

  const build = async () => {
    setBuilding(true);
    try {
      await api.buildReviewClusters(tenderId, true);
      await load();
      toastSuccess('Итог собран');
    } catch (err) { toastError(err.message); }
    setBuilding(false);
  };

  const onDecide = async (clusterId, payload) => {
    try {
      const res = await decideCluster(clusterId, payload);
      setClusters((prev) =>
        prev.map((c) => (c.id === clusterId ? { ...c, decision: res?.decision || { decision: payload.decision, ...payload } } : c)),
      );
      toastSuccess('Решение сохранено');
    } catch (err) { toastError(err.message); }
  };

  const switchMode = async (m) => {
    setMode(m);
    await load(m);
  };

  if (reviewStep?.status === 'locked') {
    return <GateNotice stepId="review" />;
  }

  const decidedCount = clusters.filter((c) => c.decision).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm text-gray-600">
            Рецензия по сгруппированным замечаниям (кластерам). Одно решение на кластер — оно и попадёт в экспорт.
          </div>
          {clusters.length > 0 && (
            <div className="text-xs text-gray-500 mt-1">Обработано: {decidedCount} из {clusters.length}</div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded border overflow-hidden text-xs">
            <button className={`px-2 py-1 ${mode === 'working' ? 'bg-brand-600 text-white' : 'bg-white text-gray-600'}`} onClick={() => switchMode('working')}>Значимые</button>
            <button className={`px-2 py-1 ${mode === 'full' ? 'bg-brand-600 text-white' : 'bg-white text-gray-600'}`} onClick={() => switchMode('full')}>Все</button>
          </div>
          <button className="btn btn-secondary text-xs" disabled={building} onClick={build}>
            {building ? 'Собираю…' : 'Пересобрать итог'}
          </button>
        </div>
      </div>

      {clusters.length === 0 ? (
        <EmptyState
          title={loaded ? 'Кластеры ещё не собраны' : 'Загрузка…'}
          description={loaded ? 'Соберите итог из находок стадий 1–4 — конвейер сгруппирует замечания по местам ТЗ.' : ''}
          action={loaded ? <button className="btn btn-primary" disabled={building} onClick={build}>{building ? 'Собираю…' : 'Собрать итог'}</button> : null}
        />
      ) : (
        clusters.map((c) => <ClusterCard key={c.id} cluster={c} onDecide={onDecide} />)
      )}
    </div>
  );
}
