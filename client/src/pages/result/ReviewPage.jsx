import { useEffect, useState } from 'react';
import { api } from '../../services/api';
import { criticalityClass, CRITICALITY, STAGE_LABELS, ACTIONS } from '../../utils/labels';
import { toastError, toastSuccess } from '../../store/useToastStore';
import EmptyState from '../../components/ui/EmptyState';
import { useTenderStore } from '../../store/useTenderStore';
import { useWizardState } from '../../hooks/useWizardState';
import GateNotice from '../../components/wizard/GateNotice';
import NextStepCta from '../../components/wizard/NextStepCta';

export default function ReviewPage() {
  const tenderId = useTenderStore((s) => s.tenderId);
  const decideIssue = useTenderStore((s) => s.decideIssue);
  const { steps } = useWizardState();
  const reviewStep = steps.find((s) => s.id === 'review');

  const [pending, setPending] = useState([]);
  const [idx, setIdx] = useState(0);
  const [draftRed, setDraftRed] = useState('');
  const [draftCom, setDraftCom] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    if (!tenderId) return;
    try {
      const all = [];
      for (let s = 1; s <= 4; s++) {
        try {
          const data = await api.listStageIssues(tenderId, s, { review_status: 'pending' });
          for (const it of data.items || []) all.push(it);
        } catch (_e) { /* skip */ }
      }
      setPending(all);
      setIdx(0);
    } catch (err) { toastError(err.message); }
  };

  useEffect(() => {
    if (reviewStep?.status === 'locked') return;
    load();
    /* eslint-disable-next-line */
  }, [tenderId, reviewStep?.status]);

  useEffect(() => {
    const cur = pending[idx];
    if (cur) {
      setDraftRed(cur.edited_redaction || cur.suggested_redaction || '');
      setDraftCom(cur.review_comment || '');
    }
  }, [idx, pending]);

  if (reviewStep?.status === 'locked') {
    return <GateNotice stepId="review" />;
  }

  if (!pending.length) {
    return (
      <div className="space-y-4">
        <EmptyState title="Нет замечаний на рассмотрении" description="Все замечания обработаны или анализ ещё не запускался." />
        <NextStepCta hint="Все pending замечания обработаны — можно переходить к экспорту." />
      </div>
    );
  }

  const cur = pending[idx];

  const decide = async (decision) => {
    setBusy(true);
    try {
      await decideIssue(cur.id, { decision, edited_redaction: draftRed, final_comment: draftCom });
      toastSuccess('Решение сохранено');
      const next = [...pending];
      next.splice(idx, 1);
      setPending(next);
      if (idx >= next.length) setIdx(Math.max(0, next.length - 1));
    } catch (err) { toastError(err.message); }
    setBusy(false);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm text-gray-600">Сквозной режим рецензии. Принимайте, редактируйте или удаляйте каждое замечание.</div>
          <div className="text-xs text-gray-500 mt-1">Прогресс: {idx + 1} из {pending.length}</div>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn btn-secondary" disabled={idx === 0} onClick={() => setIdx(idx - 1)}>← Предыдущее</button>
          <button className="btn btn-secondary" disabled={idx >= pending.length - 1} onClick={() => setIdx(idx + 1)}>Следующее →</button>
        </div>
      </div>

      <div className="card p-4">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <span className="tag bg-gray-100 text-gray-800">Стадия {cur.analysis_stage}</span>
          <span className="text-xs text-gray-500">{STAGE_LABELS[cur.analysis_stage]}</span>
          <span className={`tag ${criticalityClass(cur.criticality)}`}>{CRITICALITY[cur.criticality]}</span>
          <span className="tag bg-blue-100 text-blue-800">{ACTIONS[cur.suggested_action] || cur.suggested_action}</span>
          <span className="tag bg-gray-100 text-gray-700 text-xs">эвристика, {(cur.confidence * 100).toFixed(0)}%</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <div className="label">Исходный фрагмент {cur.source_clause ? `(${cur.source_clause})` : ''}</div>
            <div className="p-3 bg-gray-50 border rounded text-sm whitespace-pre-wrap">{cur.source_fragment || '—'}</div>
            {cur.basis && <div className="text-xs text-gray-600 mt-2"><strong>Основание:</strong> {cur.basis}</div>}
            <div className="text-xs text-gray-600 mt-1">Тип: {cur.problem_type?.replace(/_/g, ' ')}</div>
          </div>
          <div>
            <div className="label">Предлагаемая редакция</div>
            <textarea className="input min-h-[120px]" value={draftRed} onChange={(e) => setDraftRed(e.target.value)} />
            <div className="label mt-2">Комментарий для рецензии</div>
            <textarea className="input min-h-[80px]" value={draftCom} onChange={(e) => setDraftCom(e.target.value)} />
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2 justify-end">
          <button className="btn btn-secondary" disabled={busy} onClick={() => decide('reject')}>Отклонить</button>
          <button className="btn btn-secondary" disabled={busy} onClick={() => decide('edit')}>Принять с правкой</button>
          <button className="btn btn-primary" disabled={busy} onClick={() => decide('accept')}>Принять</button>
          <button className="btn btn-danger" disabled={busy} onClick={() => decide('delete')}>Удалить из ТЗ</button>
        </div>
      </div>

      <NextStepCta hint="После обработки всех pending — переходите к экспорту." />
    </div>
  );
}
