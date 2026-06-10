import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../services/api';
import { useTenderStore } from '../../store/useTenderStore';
import { useWizardState } from '../../hooks/useWizardState';
import GateNotice from '../../components/wizard/GateNotice';
import { USER_DECISION_LABELS, DECISIONS, formatProblemType, criticalityClass, CRITICALITY } from '../../utils/labels';

// Что ляжет в Word по решению кластера (зеркало server/review/decisionModel.js).
const EXPORT_HINT = {
  accept: 'Word: комментарий',
  edit: 'Word: правка',
  delete: 'Word: удаление',
  remove_from_scope: 'Word: вынести из объёма',
  reject: 'не экспортируется',
};

const VERDICT = {
  review_edit: { label: 'В Word: правка', cls: 'text-blue-700 bg-blue-50' },
  review_comment: { label: 'В Word: комментарий', cls: 'text-green-700 bg-green-50' },
  rejected: { label: 'Отклонено', cls: 'text-gray-600 bg-gray-100' },
  pending: { label: 'На рассмотрении', cls: 'text-amber-700 bg-amber-50' },
};

function Chip({ children, cls = 'text-gray-700 bg-gray-100' }) {
  return <span className={`px-2 py-0.5 rounded ${cls}`}>{children}</span>;
}

export default function SummaryPage() {
  const tenderId = useTenderStore((s) => s.tenderId);
  const { steps } = useWizardState();
  const navigate = useNavigate();
  const step = steps.find((s) => s.id === 'summary');

  const [clusters, setClusters] = useState([]);
  const [consolidated, setConsolidated] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!tenderId) return;
    setLoading(true);
    setErr(null);
    try {
      // Основной итог — кластеры с решениями. Старый сводный вид (issues) — рядом, как fallback.
      const [c, cons] = await Promise.all([
        api.listReviewClusters(tenderId, 'full'),
        api.getConsolidated(tenderId).catch(() => null),
      ]);
      setClusters(c.items || []);
      setConsolidated(cons);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, [tenderId]);

  useEffect(() => {
    if (tenderId && step?.status !== 'locked') load();
  }, [tenderId, step?.status, load]);

  if (!tenderId) return null;
  if (step?.status === 'locked') return <GateNotice stepId="summary" />;

  const decided = clusters.filter((c) => c.decision);
  const toWord = decided.filter((c) => c.decision.decision !== 'reject').length;
  const pending = clusters.length - decided.length;

  const groups = consolidated?.groups || [];

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-gray-600">
          Единый итог по кластерам: замечания со всех стадий сгруппированы по местам ТЗ. Одно решение на кластер — оно и попадёт в экспорт.
        </p>
        <button type="button" className="btn btn-secondary text-xs whitespace-nowrap" onClick={load} disabled={loading}>
          {loading ? 'Собираю…' : 'Обновить'}
        </button>
      </div>

      {err && <div className="text-xs text-red-600">{err}</div>}

      <div className="flex flex-wrap gap-2 text-xs">
        <Chip>Кластеров: {clusters.length}</Chip>
        <Chip cls="text-green-700 bg-green-50">Решено: {decided.length}</Chip>
        <Chip cls="text-blue-700 bg-blue-50">В Word: {toWord}</Chip>
        <Chip cls="text-amber-700 bg-amber-50">На рассмотрении: {pending}</Chip>
      </div>

      {clusters.length === 0 ? (
        <div className="text-sm text-gray-500">
          Итог ещё не собран — пройдите стадии 1–4 и нажмите «Собрать итог» в рецензии.
        </div>
      ) : (
        <div className="space-y-2">
          {clusters.map((c) => (
            <div key={c.id} className="card p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap text-xs mb-1">
                    <span className={`px-1.5 py-0.5 rounded ${criticalityClass(c.overall_criticality)}`}>
                      {CRITICALITY[c.overall_criticality] || c.overall_criticality}
                    </span>
                    <span className="font-medium text-gray-800">{c.cluster_title}</span>
                    {c.decision ? (
                      <span className="px-1.5 py-0.5 rounded text-green-700 bg-green-50">
                        {DECISIONS[c.decision.decision] || c.decision.decision} · {EXPORT_HINT[c.decision.decision]}
                      </span>
                    ) : (
                      <span className="px-1.5 py-0.5 rounded text-amber-700 bg-amber-50">не решено</span>
                    )}
                  </div>
                  {c.merged_basis && <div className="text-sm text-gray-700 break-words whitespace-pre-wrap">{c.merged_basis}</div>}
                </div>
                {!c.decision && (
                  <button
                    type="button"
                    className="btn btn-secondary text-xs whitespace-nowrap"
                    onClick={() => navigate(`/tenders/${tenderId}/review`)}
                  >
                    В рецензию
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {groups.length > 0 && (
        <details className="card p-3">
          <summary className="text-sm text-gray-600 cursor-pointer">
            Старый сводный вид по находкам стадий (issues) — {groups.length} групп
          </summary>
          <div className="space-y-2 mt-2">
            {groups.map((g) => (
              <div key={g.id} className={`border rounded p-2 ${g.conflict ? 'border-rose-300' : ''}`}>
                <div className="flex items-center gap-2 flex-wrap text-xs mb-1">
                  <span className={`px-1.5 py-0.5 rounded ${VERDICT[g.verdict]?.cls || ''}`}>{VERDICT[g.verdict]?.label || g.verdict}</span>
                  <span className={`px-1.5 py-0.5 rounded ${criticalityClass(g.primary.criticality)}`}>{g.primary.criticality || '—'}</span>
                  <span className="text-gray-500">Стадия {g.primary.stage} · {formatProblemType(g.primary.problem_type)}</span>
                  {g.conflict && <span className="px-1.5 py-0.5 rounded text-rose-700 bg-rose-50">⚠ конфликт</span>}
                </div>
                <div className="text-sm text-gray-800 break-words">{g.fragment ? `«${g.fragment}»` : '—'}</div>
                {g.primary.decision_kind && (
                  <div className="text-xs text-gray-500 mt-0.5">
                    Решение: {USER_DECISION_LABELS[g.primary.decision_kind] || g.primary.decision_kind}
                  </div>
                )}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
