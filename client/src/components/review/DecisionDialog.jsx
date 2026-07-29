// Компактный диалог решения: выбор структурированной причины (обязательна для
// «Отклонить» и «Принять с изменением»), текст правки, цель объединения, новый
// приоритет. Комментарий необязателен, кроме причины «Другая причина».

import { useEffect, useMemo, useState } from 'react';
import Modal from '../ui/Modal';
import { clusterTopic, humanizeNote, truncate } from '../../utils/format';
import {
  ACTIONS_NEEDING_REASON,
  DECISION_REASONS,
  PRIORITIES,
  validateDecisionForm,
} from '../../utils/reviewBoard';

const TITLES = {
  reject: 'Отклонить замечание',
  edit: 'Принять с изменением',
  accept: 'Принять замечание',
  merge: 'Объединить с другим замечанием',
  priority: 'Изменить приоритет',
};

export default function DecisionDialog({ open, action, cluster, candidates = [], busy, onSubmit, onClose }) {
  const [reasonCode, setReasonCode] = useState('');
  const [comment, setComment] = useState('');
  const [finalText, setFinalText] = useState('');
  const [mergeTargetId, setMergeTargetId] = useState('');
  const [priority, setPriority] = useState('');
  const [error, setError] = useState('');

  const aiVariant = useMemo(
    () => humanizeNote((cluster && cluster.merged_recommendation) || ''),
    [cluster],
  );

  // Свежая форма на каждое открытие; правка префиллится вариантом ИИ.
  useEffect(() => {
    if (!open) return;
    setReasonCode('');
    setComment('');
    setFinalText(action === 'edit' ? aiVariant : '');
    setMergeTargetId('');
    setPriority('');
    setError('');
  }, [open, action, cluster && cluster.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open || !cluster) return null;

  const needsReason = ACTIONS_NEEDING_REASON.includes(action);
  const commentRequired = needsReason && reasonCode === 'other';

  const submit = () => {
    const form = { reasonCode, comment, finalText, mergeTargetId, priority };
    const check = validateDecisionForm(action, form);
    if (!check.ok) {
      setError(check.error);
      return;
    }
    onSubmit(action, form);
  };

  return (
    <Modal open={open} onClose={busy ? undefined : onClose} title={TITLES[action] || 'Решение'} size="md">
      <div className="space-y-3">
        <div className="text-xs text-gray-500 dark:text-gray-400">
          {truncate(clusterTopic(cluster) || cluster.cluster_title || '', 120)}
        </div>

        {action === 'edit' && (
          <div>
            <div className="label">Итоговая редакция замечания *</div>
            <textarea
              className="input min-h-[80px] text-sm"
              value={finalText}
              onChange={(e) => setFinalText(e.target.value)}
              placeholder="Как должно звучать замечание / правка ТЗ"
            />
          </div>
        )}

        {action === 'merge' && (
          <div>
            <div className="label">Объединить с замечанием *</div>
            <select
              className="input text-sm"
              value={mergeTargetId}
              onChange={(e) => setMergeTargetId(e.target.value)}
            >
              <option value="">— выберите замечание —</option>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  №{c.index + 1} · {truncate(clusterTopic(c.cluster) || c.cluster.cluster_title || c.id, 80)}
                </option>
              ))}
            </select>
          </div>
        )}

        {action === 'priority' && (
          <div>
            <div className="label">Новый приоритет *</div>
            <div className="flex gap-2 flex-wrap">
              {PRIORITIES.map((p) => (
                <button
                  key={p.code}
                  type="button"
                  className={`btn text-xs ${priority === p.code ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setPriority(p.code)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {needsReason && (
          <div>
            <div className="label">Причина решения *</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1">
              {DECISION_REASONS.map((r) => (
                <label key={r.code} className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
                  <input
                    type="radio"
                    name="decision-reason"
                    checked={reasonCode === r.code}
                    onChange={() => setReasonCode(r.code)}
                  />
                  {r.label}
                </label>
              ))}
            </div>
          </div>
        )}

        <div>
          <div className="label">
            Комментарий {commentRequired ? '*' : '(необязательно)'}
          </div>
          <textarea
            className="input min-h-[56px] text-sm"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder={commentRequired ? 'Опишите причину своими словами' : 'Пояснение к решению'}
          />
        </div>

        {error && <div className="text-xs text-red-600 dark:text-red-400">{error}</div>}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={onClose}>
            Отмена
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={submit}>
            {busy ? 'Сохраняю…' : 'Сохранить решение'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
