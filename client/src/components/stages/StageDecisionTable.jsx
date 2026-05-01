import { useState, useEffect, useRef } from 'react';
import {
  CRITICALITY,
  criticalityClass,
  REVIEW_STATUS,
  USER_DECISION_LABELS,
  formatProblemType,
} from '../../utils/labels';
import { truncate } from '../../utils/format';
import { api } from '../../services/api';
import { toastError, toastSuccess } from '../../store/useToastStore';

// 4 UI-кнопки → существующие БД-decisions.
// reject / delete сохраняются сразу. edit переключает в режим ввода нового текста.
// accept («Примечание») — режим ввода комментария.
const BUTTONS = [
  {
    kind: 'reject', label: 'Отклонить', mode: null,
    idleClass: 'btn-secondary',
    activeClass: 'bg-gray-700 text-white border-gray-700 hover:bg-gray-800',
  },
  {
    kind: 'delete', label: 'Удалить', mode: null,
    idleClass: 'btn-secondary text-red-600',
    activeClass: 'bg-red-600 text-white border-red-600 hover:bg-red-700',
  },
  {
    kind: 'edit', label: 'Изменить', mode: 'edit',
    idleClass: 'btn-secondary',
    activeClass: 'bg-blue-600 text-white border-blue-600 hover:bg-blue-700',
  },
  {
    kind: 'accept', label: 'Примечание', mode: 'note',
    idleClass: 'btn-secondary',
    activeClass: 'bg-amber-500 text-white border-amber-500 hover:bg-amber-600',
  },
];

export default function StageDecisionTable({ issues, readOnly, onChanged }) {
  // Раскрытие отслеживается по ИНДЕКСУ строки в массиве, не по issue.id —
  // защита от потенциальных дубликатов id и React-quirks с фрагментами в tbody.
  const [expandedIdx, setExpandedIdx] = useState(null);

  const decide = async (issue, decision, drafts) => {
    try {
      await api.decideIssue(issue.id, {
        decision,
        edited_redaction: drafts.redaction || '',
        final_comment: drafts.comment || '',
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
            <th className="table-head w-28">Пункт ТЗ</th>
            <th className="table-head">Текст ТЗ</th>
            <th className="table-head w-44">Тип замечания</th>
            <th className="table-head">Решение</th>
          </tr>
        </thead>
        <tbody>
          {issues.map((it, idx) => (
            <RowGroup
              key={`${it.id}__${idx}`}
              issue={it}
              expanded={expandedIdx === idx}
              onToggle={() => setExpandedIdx((prev) => (prev === idx ? null : idx))}
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
  // mode: null — раскрыто без активного редактирования
  //       'edit' — режим «Изменить»
  //       'note' — режим «Примечание»
  // *Locked — текстовое поле уже сохранено (read-only),
  //   рядом появляется кнопка «Редактировать» для разблокировки.
  const [mode, setMode] = useState(null);
  const [editLocked, setEditLocked] = useState(false);
  const [noteLocked, setNoteLocked] = useState(false);
  const [draftRed, setDraftRed] = useState('');
  const [draftCom, setDraftCom] = useState('');
  // Оптимистичная индикация выбора решения — мгновенно подсвечиваем
  // нажатую кнопку, не дожидаясь ответа сервера. Сбрасывается, когда
  // серверный decision_kind совпал с оптимистичным.
  const [pendingDecision, setPendingDecision] = useState(null);
  const editRef = useRef(null);
  const noteRef = useRef(null);

  // При сворачивании сбрасываем режим (lock-флаги остаются — текст не теряется).
  useEffect(() => {
    if (!expanded) setMode(null);
  }, [expanded]);

  // Фокус на нужный textarea при входе в режим или при разблокировке.
  useEffect(() => {
    if (mode === 'edit' && !editLocked) editRef.current?.focus();
    else if (mode === 'note' && !noteLocked) noteRef.current?.focus();
  }, [mode, editLocked, noteLocked]);

  // Сбрасываем pending когда серверная версия догнала оптимистичную.
  useEffect(() => {
    if (pendingDecision && issue.decision_kind === pendingDecision) {
      setPendingDecision(null);
    }
  }, [issue.decision_kind, pendingDecision]);

  const click = (btn) => {
    if (readOnly) return;
    // Кнопки без режима (Отклонить / Удалить) — сохраняем сразу и скрываем
    // любое поле ввода: при этих решениях текст/примечание не нужны.
    if (!btn.mode) {
      setPendingDecision(btn.kind);
      onDecide(issue, btn.kind, { redaction: '', comment: '' });
      setMode(null);
      return;
    }
    // Кнопки с режимом (Изменить / Примечание): раскрываем строку, разблокируем поле.
    if (!expanded) onToggle();
    setMode(btn.mode);
    if (btn.mode === 'edit') setEditLocked(false);
    if (btn.mode === 'note') setNoteLocked(false);
  };

  const submitEdit = () => {
    if (!draftRed.trim()) {
      toastError('Введите новый текст и нажмите Enter');
      return;
    }
    setPendingDecision('edit');
    onDecide(issue, 'edit', { redaction: draftRed, comment: '' });
    setEditLocked(true);
  };

  const submitNote = () => {
    if (!draftCom.trim()) {
      toastError('Введите примечание и нажмите Enter');
      return;
    }
    setPendingDecision('accept');
    onDecide(issue, 'accept', { redaction: '', comment: draftCom });
    setNoteLocked(true);
  };

  const onKeyEnter = (handler, isLocked) => (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setMode(null);
      return;
    }
    if (isLocked) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handler();
    }
  };

  // Эффективное решение = pending (если есть, для мгновенного UI) или серверное.
  const effectiveDecision = pendingDecision || issue.decision_kind;
  const decisionBadge = effectiveDecision ? USER_DECISION_LABELS[effectiveDecision] : null;
  const statusBadge = pendingDecision ? 'Сохранение…' : (REVIEW_STATUS[issue.review_status] || null);

  return (
    <>
      <tr className="border-t border-gray-100 hover:bg-gray-50">
        <td
          className="table-cell text-center align-middle cursor-pointer hover:bg-gray-100 select-none"
          onClick={onToggle}
          role="button"
          aria-label="Развернуть"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
        >
          <span className="text-gray-500 text-base">{expanded ? '▾' : '▸'}</span>
        </td>
        <td className="table-cell text-sm align-top pt-2 whitespace-nowrap">
          {issue.source_clause || '—'}
        </td>
        <td className="table-cell align-top pt-2">
          <div className="text-sm">{truncate(issue.source_fragment, 220)}</div>
          {issue.criticality && (
            <span className={`tag mt-1 inline-block ${criticalityClass(issue.criticality)}`}>
              {CRITICALITY[issue.criticality] || issue.criticality}
            </span>
          )}
        </td>
        <td className="table-cell text-sm align-top pt-2">
          {formatProblemType(issue.problem_type)}
        </td>
        <td className="table-cell align-top pt-2">
          {readOnly ? (
            <span className="text-xs text-gray-500">{decisionBadge || '—'}</span>
          ) : (
            <div className="flex flex-col gap-1.5">
              {decisionBadge && (
                <span className="text-xs text-gray-600">
                  Текущее: <strong>{decisionBadge}</strong>
                  {statusBadge && <span className="text-gray-400"> · {statusBadge}</span>}
                </span>
              )}
              <div className="flex flex-wrap gap-1">
                {BUTTONS.map((btn) => {
                  const isActive = effectiveDecision === btn.kind;
                  return (
                    <button
                      key={btn.kind}
                      className={`btn text-xs ${isActive ? btn.activeClass : btn.idleClass}`}
                      onClick={() => click(btn)}
                    >
                      {btn.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </td>
      </tr>
      <tr className="bg-gray-50" hidden={!expanded}>
        <td></td>
        <td className="table-cell" colSpan={4}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 py-2">
            <div>
              <div className="label">Полный фрагмент ТЗ</div>
              <div className="p-2 bg-white border rounded text-sm whitespace-pre-wrap">
                {issue.source_fragment || '—'}
              </div>
              {issue.basis && (
                <div className="mt-2 text-xs text-gray-600">
                  <strong>Основание:</strong> {issue.basis}
                </div>
              )}
              <div className="mt-2 text-xs text-gray-500">
                Стадия: {issue.analysis_stage}
                {typeof issue.confidence === 'number' && (
                  <> • Уверенность: {(issue.confidence * 100).toFixed(0)}%</>
                )}
              </div>
              {!readOnly && (
                <label className="flex items-center gap-1 text-xs mt-2">
                  <input
                    type="checkbox"
                    checked={!!issue.selected_for_export}
                    onChange={(e) => onPatch(issue, { selected_for_export: e.target.checked })}
                  />
                  Включать в экспорт
                </label>
              )}
            </div>
            <div>
              {mode === 'edit' && (
                <>
                  <div className="label flex items-center justify-between gap-2">
                    <span>
                      Новый текст {editLocked ? '(сохранён)' : '(Enter — сохранить)'}
                    </span>
                    {editLocked && !readOnly && (
                      <button
                        type="button"
                        className="btn btn-secondary text-xs"
                        onClick={() => setEditLocked(false)}
                      >
                        Редактировать
                      </button>
                    )}
                  </div>
                  <textarea
                    ref={editRef}
                    className={`input min-h-[100px] ${editLocked ? 'bg-gray-100 cursor-default' : ''}`}
                    placeholder="Введите заменяющий текст…"
                    value={draftRed}
                    onChange={(e) => setDraftRed(e.target.value)}
                    onKeyDown={onKeyEnter(submitEdit, editLocked)}
                    disabled={readOnly}
                    readOnly={editLocked}
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    {editLocked
                      ? 'Сохранено. Нажмите «Редактировать», чтобы изменить.'
                      : 'Enter — сохранить · Shift+Enter — перенос строки · Esc — отменить'}
                  </p>
                </>
              )}
              {mode === 'note' && (
                <>
                  <div className="label flex items-center justify-between gap-2">
                    <span>
                      Примечание {noteLocked ? '(сохранено)' : '(Enter — сохранить)'}
                    </span>
                    {noteLocked && !readOnly && (
                      <button
                        type="button"
                        className="btn btn-secondary text-xs"
                        onClick={() => setNoteLocked(false)}
                      >
                        Редактировать
                      </button>
                    )}
                  </div>
                  <textarea
                    ref={noteRef}
                    className={`input min-h-[100px] ${noteLocked ? 'bg-gray-100 cursor-default' : ''}`}
                    placeholder="Текст комментария к фрагменту…"
                    value={draftCom}
                    onChange={(e) => setDraftCom(e.target.value)}
                    onKeyDown={onKeyEnter(submitNote, noteLocked)}
                    disabled={readOnly}
                    readOnly={noteLocked}
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    {noteLocked
                      ? 'Сохранено. Нажмите «Редактировать», чтобы изменить.'
                      : 'Enter — сохранить · Shift+Enter — перенос строки · Esc — отменить'}
                  </p>
                </>
              )}
              {!mode && (
                <p className="text-xs text-gray-500 italic">
                  Нажмите «Изменить» или «Примечание», чтобы внести правку.
                </p>
              )}
            </div>
          </div>
        </td>
      </tr>
    </>
  );
}
