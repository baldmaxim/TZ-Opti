import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../services/api';
import { useTenderStore } from '../../store/useTenderStore';
import { useWizardState } from '../../hooks/useWizardState';
import GateNotice from '../../components/wizard/GateNotice';
import { USER_DECISION_LABELS, formatProblemType, criticalityClass } from '../../utils/labels';

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

  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!tenderId) return;
    setLoading(true);
    setErr(null);
    try {
      setData(await api.getConsolidated(tenderId));
    } catch (e) {
      setErr(e.message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [tenderId]);

  useEffect(() => {
    if (tenderId && step?.status !== 'locked') load();
  }, [tenderId, step?.status, load]);

  if (!tenderId) return null;
  if (step?.status === 'locked') return <GateNotice stepId="summary" />;

  const summary = data?.summary;
  const groups = data?.groups || [];

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-gray-600">
          Единый итог по всем стадиям: находки, указывающие на одно место ТЗ, сведены в группы. На каждое место — одно главное решение (по критичности), остальные показаны рядом. Конфликты решает инженер в рецензии.
        </p>
        <button type="button" className="btn btn-secondary text-xs whitespace-nowrap" onClick={load} disabled={loading}>
          {loading ? 'Собираю…' : 'Обновить'}
        </button>
      </div>

      {err && <div className="text-xs text-red-600">{err}</div>}

      {summary && (
        <div className="flex flex-wrap gap-2 text-xs">
          <Chip>Групп: {summary.groups}</Chip>
          <Chip>Находок: {summary.findings}</Chip>
          <Chip cls="text-blue-700 bg-blue-50">В Word (правка): {summary.review_edit}</Chip>
          <Chip cls="text-green-700 bg-green-50">В Word (коммент.): {summary.review_comment}</Chip>
          <Chip cls="text-gray-600 bg-gray-100">Отклонено: {summary.rejected}</Chip>
          <Chip cls="text-amber-700 bg-amber-50">На рассмотрении: {summary.pending}</Chip>
          {summary.conflicts > 0 && <Chip cls="text-rose-700 bg-rose-50">Конфликтов: {summary.conflicts}</Chip>}
        </div>
      )}

      {summary && groups.length === 0 && (
        <div className="text-sm text-gray-500">Пока нет находок для сборки — запустите стадии анализа.</div>
      )}

      <div className="space-y-2">
        {groups.map((g) => (
          <div key={g.id} className={`card p-3 ${g.conflict ? 'border-rose-300' : ''}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap text-xs mb-1">
                  <span className={`px-1.5 py-0.5 rounded ${VERDICT[g.verdict]?.cls || ''}`}>{VERDICT[g.verdict]?.label || g.verdict}</span>
                  <span className={`px-1.5 py-0.5 rounded ${criticalityClass(g.primary.criticality)}`}>{g.primary.criticality || '—'}</span>
                  <span className="text-gray-500">Стадия {g.primary.stage} · {formatProblemType(g.primary.problem_type)}</span>
                  {g.conflict && <span className="px-1.5 py-0.5 rounded text-rose-700 bg-rose-50">⚠ конфликт</span>}
                  {g.multi_stage && <span className="text-gray-400">стадии: {g.stages.join(', ')}</span>}
                </div>
                <div className="text-sm text-gray-800 break-words">{g.fragment ? `«${g.fragment}»` : '—'}</div>
                {g.primary.decision_kind && (
                  <div className="text-xs text-gray-500 mt-0.5">
                    Решение: {USER_DECISION_LABELS[g.primary.decision_kind] || g.primary.decision_kind}
                  </div>
                )}
                {g.related.length > 0 && (
                  <details className="mt-1">
                    <summary className="text-xs text-gray-500 cursor-pointer">Это место также отметили: {g.related.length}</summary>
                    <ul className="mt-1 space-y-0.5">
                      {g.related.map((r) => (
                        <li key={r.id} className="text-xs text-gray-500">
                          Стадия {r.stage}: {formatProblemType(r.problem_type)} ({r.criticality || '—'}
                          {r.decision_kind ? `, ${USER_DECISION_LABELS[r.decision_kind] || r.decision_kind}` : ', не решено'})
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
              {(g.verdict === 'pending' || g.conflict) && (
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
    </div>
  );
}
