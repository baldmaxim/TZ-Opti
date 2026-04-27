import { useState } from 'react';
import { ACTIONS, CRITICALITY, criticalityClass, REVIEW_STATUS, DECISIONS } from '../../utils/labels';
import { truncate } from '../../utils/format';
import { api } from '../../services/api';
import { toastError, toastSuccess } from '../../store/useToastStore';

export default function StageDecisionTable({ issues, readOnly, onChanged }) {
  const [expanded, setExpanded] = useState(null);

  const decide = async (issue, decision) => {
    try {
      const editedRedaction = issue._draft_redaction !== undefined ? issue._draft_redaction : (issue.edited_redaction || issue.suggested_redaction || '');
      const finalComment = issue._draft_comment !== undefined ? issue._draft_comment : (issue.review_comment || '');
      await api.decideIssue(issue.id, {
        decision,
        edited_redaction: editedRedaction,
        final_comment: finalComment,
      });
      toastSuccess('Решение сохранено');
      onChanged && onChanged();
    } catch (err) { toastError(err.message); }
  };

  const patch = async (issue, patchData) => {
    try {
      await api.patchIssue(issue.id, patchData);
      onChanged && onChanged();
    } catch (err) { toastError(err.message); }
  };

  if (!issues.length) {
    return <p className="text-sm text-gray-500">Замечаний не найдено. Запустите анализ или измените входные данные.</p>;
  }

  return (
    <div className="card overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr>
            <th className="table-head w-8"></th>
            <th className="table-head">Фрагмент</th>
            <th className="table-head">Тип</th>
            <th className="table-head">Критичность</th>
            <th className="table-head">Действие</th>
            <th className="table-head">Статус</th>
            <th className="table-head">Решение</th>
          </tr>
        </thead>
        <tbody>
          {issues.map((it) => (
            <RowGroup
              key={it.id}
              issue={it}
              expanded={expanded === it.id}
              onToggle={() => setExpanded(expanded === it.id ? null : it.id)}
              onDecide={decide}
              onPatch={patch}
              readOnly={readOnly}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RowGroup({ issue, expanded, onToggle, onDecide, onPatch, readOnly }) {
  const [draftRed, setDraftRed] = useState(issue.edited_redaction || issue.suggested_redaction || '');
  const [draftCom, setDraftCom] = useState(issue.review_comment || '');

  const decisionWith = (kind) => {
    issue._draft_redaction = draftRed;
    issue._draft_comment = draftCom;
    onDecide(issue, kind);
  };

  return (
    <>
      <tr className="border-t border-gray-100 hover:bg-gray-50">
        <td className="table-cell text-center">
          <button onClick={onToggle} className="text-gray-500">{expanded ? '▾' : '▸'}</button>
        </td>
        <td className="table-cell max-w-xs">
          <div className="font-medium text-sm">{truncate(issue.source_fragment, 120)}</div>
          {issue.source_clause && <div className="text-xs text-gray-500">{issue.source_clause}</div>}
        </td>
        <td className="table-cell text-sm">{issue.problem_type?.replace(/_/g, ' ')}</td>
        <td className="table-cell">
          <span className={`tag ${criticalityClass(issue.criticality)}`}>{CRITICALITY[issue.criticality] || issue.criticality}</span>
        </td>
        <td className="table-cell text-sm">{ACTIONS[issue.suggested_action] || issue.suggested_action}</td>
        <td className="table-cell text-sm">{REVIEW_STATUS[issue.review_status] || issue.review_status}</td>
        <td className="table-cell whitespace-nowrap">
          {readOnly ? (
            <span className="text-xs text-gray-500">{issue.decision_kind ? DECISIONS[issue.decision_kind] : '—'}</span>
          ) : (
            <div className="flex flex-wrap gap-1">
              <button className="btn btn-secondary text-xs" onClick={() => decisionWith('accept')}>Принять</button>
              <button className="btn btn-secondary text-xs" onClick={() => decisionWith('edit')}>Изменить</button>
              <button className="btn btn-secondary text-xs" onClick={() => decisionWith('reject')}>Отклонить</button>
              <button className="btn btn-danger text-xs" onClick={() => decisionWith('delete')}>Удалить из ТЗ</button>
            </div>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className="bg-gray-50">
          <td></td>
          <td className="table-cell" colSpan={6}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 py-2">
              <div>
                <div className="label">Исходный фрагмент</div>
                <div className="p-2 bg-white border rounded text-sm whitespace-pre-wrap">{issue.source_fragment || '—'}</div>
                {issue.basis && <div className="mt-2 text-xs text-gray-600"><strong>Основание:</strong> {issue.basis}</div>}
                <div className="mt-2 text-xs text-gray-500">
                  Стадия: {issue.analysis_stage} • Уверенность: {(issue.confidence * 100).toFixed(0)}% • <span className="tag bg-gray-100 text-gray-700">эвристика</span>
                </div>
              </div>
              <div>
                <div className="label">Предлагаемая редакция</div>
                <textarea
                  className="input min-h-[80px]"
                  value={draftRed}
                  onChange={(e) => setDraftRed(e.target.value)}
                  disabled={readOnly}
                />
                <div className="label mt-2">Комментарий для рецензии</div>
                <textarea
                  className="input min-h-[60px]"
                  value={draftCom}
                  onChange={(e) => setDraftCom(e.target.value)}
                  disabled={readOnly}
                />
                {!readOnly && (
                  <div className="flex items-center gap-2 mt-2">
                    <label className="flex items-center gap-1 text-xs">
                      <input
                        type="checkbox"
                        checked={!!issue.selected_for_export}
                        onChange={(e) => onPatch(issue, { selected_for_export: e.target.checked })}
                      />
                      Включать в экспорт
                    </label>
                  </div>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
