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
// reject сохраняется сразу (поля не нужны, в экспорт не идёт).
// delete / edit / note — ОТКРЫВАЮТ панель с полями и явной кнопкой «Сохранить»:
// оба поля (новый текст + примечание) уходят одним сохранением, ничего не теряется.
const BUTTONS = [
  {
    kind: 'reject', label: 'Отклонить', mode: null,
    idleClass: 'btn-secondary',
    activeClass: 'bg-gray-700 text-white border-gray-700 hover:bg-gray-800',
  },
  {
    kind: 'delete', label: 'Удалить', mode: 'delete',
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
        target_text: drafts.target || '',
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
  // mode: null — раскрыто без выбранного действия
  //       'edit'   — режим «Изменить» (новый текст + необязательное примечание)
  //       'delete' — режим «Удалить» (необязательное примечание)
  //       'note'   — режим «Примечание» (комментарий без правки текста)
  const [mode, setMode] = useState(null);
  const [draftRed, setDraftRed] = useState('');
  const [draftCom, setDraftCom] = useState('');
  // Выбранная подчасть фрагмента для delete/edit ('' = весь фрагмент).
  const [draftTarget, setDraftTarget] = useState('');
  // Оптимистичная индикация выбора решения — мгновенно подсвечиваем
  // нажатую кнопку, не дожидаясь ответа сервера. Сбрасывается, когда
  // серверный decision_kind совпал с оптимистичным.
  const [pendingDecision, setPendingDecision] = useState(null);
  const [justSaved, setJustSaved] = useState(false);
  const editRef = useRef(null);
  const noteRef = useRef(null);

  // При сворачивании сбрасываем режим. При раскрытии — префилл черновиков.
  // ВАЖНО: примечание (draftCom) подставляем только из уже сохранённого решения
  // инженера (decision_comment), но НЕ из комментария анализатора (review_comment) —
  // иначе авто-подставленный текст молча уехал бы в Word. Комментарий агента
  // показываем отдельной подсказкой с кнопкой «Вставить» (см. ниже).
  useEffect(() => {
    if (!expanded) { setMode(null); return; }
    setDraftRed(issue.decision_redaction || issue.edited_redaction || issue.suggested_redaction || '');
    setDraftCom(issue.decision_comment || '');
    setDraftTarget(issue.decision_target_text || '');
    setJustSaved(false);
  }, [expanded]);

  // Фокус на нужный textarea при входе в режим.
  useEffect(() => {
    if (mode === 'edit') editRef.current?.focus();
    else if (mode === 'delete' || mode === 'note') noteRef.current?.focus();
  }, [mode]);

  // Сбрасываем pending когда серверная версия догнала оптимистичную.
  useEffect(() => {
    if (pendingDecision && issue.decision_kind === pendingDecision) {
      setPendingDecision(null);
    }
  }, [issue.decision_kind, pendingDecision]);

  // reject сохраняется сразу; delete/edit/note — открывают панель с полями
  // и явной кнопкой «Сохранить» (см. save). Ничего не сохраняем при открытии.
  const click = (btn) => {
    if (readOnly) return;
    if (btn.kind === 'reject') {
      setPendingDecision('reject');
      onDecide(issue, 'reject', { redaction: '', comment: '', target: '' });
      setMode(null);
      return;
    }
    if (!expanded) onToggle();
    setJustSaved(false);
    // При входе в «Изменить» подставляем предложенную редакцию, если поле пусто.
    if (btn.mode === 'edit' && !draftRed.trim()) {
      setDraftRed(issue.decision_redaction || issue.edited_redaction || issue.suggested_redaction || '');
    }
    setMode(btn.mode);
  };

  // Единое сохранение из раскрытой панели: оба поля уходят ВМЕСТЕ одним запросом.
  const save = () => {
    if (readOnly || !mode) return;
    if (mode === 'edit') {
      if (!draftRed.trim()) { toastError('Введите новый текст замены'); return; }
      setPendingDecision('edit');
      onDecide(issue, 'edit', { redaction: draftRed, comment: draftCom, target: draftTarget });
    } else if (mode === 'delete') {
      setPendingDecision('delete');
      onDecide(issue, 'delete', { redaction: '', comment: draftCom, target: draftTarget });
    } else if (mode === 'note') {
      if (!draftCom.trim()) { toastError('Введите текст примечания'); return; }
      setPendingDecision('accept');
      onDecide(issue, 'accept', { redaction: '', comment: draftCom, target: '' });
    }
    setJustSaved(true);
  };

  // Esc — закрыть режим; Ctrl/Cmd+Enter — сохранить (обычный Enter = перенос строки).
  const onFieldKeyDown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); setMode(null); return; }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
  };

  const editField = (e) => { setDraftRed(e.target.value); setJustSaved(false); };
  const noteField = (e) => { setDraftCom(e.target.value); setJustSaved(false); };

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
              {/* Комментарий анализатора (LLM-агента) — подсказка, НЕ примечание.
                  В Word сам по себе не попадает; инженер может вставить его в поле
                  примечания кнопкой «Вставить», если согласен с формулировкой. */}
              {issue.review_comment && (
                <div className="mb-3 p-2 bg-amber-50 border border-amber-200 rounded">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-amber-800">Комментарий анализатора</span>
                    {!readOnly && (
                      <button
                        type="button"
                        className="btn btn-secondary text-xs"
                        onClick={() => setDraftCom((c) => (c.trim() ? `${c}\n${issue.review_comment}` : issue.review_comment))}
                      >
                        Вставить в примечание
                      </button>
                    )}
                  </div>
                  <p className="text-xs text-gray-700 mt-1 whitespace-pre-wrap max-h-28 overflow-y-auto">
                    {issue.review_comment}
                  </p>
                </div>
              )}
              {/* Для высокой/критической критичности агент сразу предлагает готовую
                  редакцию фрагмента. «Применить» открывает «Изменить» с подставленным
                  текстом — инженер принимает/правит/игнорирует. */}
              {['high', 'critical'].includes(issue.criticality) && issue.suggested_redaction && (
                <div className={`mb-3 p-2 rounded border ${issue.criticality === 'critical' ? 'bg-red-50 border-red-200' : 'bg-orange-50 border-orange-200'}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className={`text-xs font-medium ${issue.criticality === 'critical' ? 'text-red-800' : 'text-orange-800'}`}>
                      Агент предлагает редакцию
                      <span className={`tag ml-2 ${criticalityClass(issue.criticality)}`}>
                        {CRITICALITY[issue.criticality] || issue.criticality}
                      </span>
                    </span>
                    {!readOnly && (
                      <button
                        type="button"
                        className="btn btn-primary text-xs"
                        onClick={() => {
                          setDraftRed(issue.suggested_redaction);
                          setDraftTarget('');
                          setJustSaved(false);
                          setMode('edit');
                        }}
                      >
                        Применить
                      </button>
                    )}
                  </div>
                  <p className="text-xs text-gray-700 mt-1 whitespace-pre-wrap max-h-28 overflow-y-auto">
                    {issue.suggested_redaction}
                  </p>
                </div>
              )}
              {mode === 'edit' && (
                <>
                  <FragmentPicker
                    fragment={issue.source_fragment || ''}
                    value={draftTarget}
                    onChange={(t) => { setDraftTarget(t); setJustSaved(false); }}
                    label="Что менять: выделите часть пункта или оставьте весь"
                    verb="заменить"
                    disabled={readOnly}
                  />
                  <div className="label mt-3">{draftTarget ? 'Новый текст для выделенной части' : 'Новый текст замены'}</div>
                  <textarea
                    ref={editRef}
                    className="input min-h-[100px]"
                    placeholder="Введите заменяющий текст…"
                    value={draftRed}
                    onChange={editField}
                    onKeyDown={onFieldKeyDown}
                    disabled={readOnly}
                  />
                  <div className="label mt-3">Примечание (необязательно)</div>
                  <textarea
                    className="input min-h-[70px]"
                    placeholder="Пояснение к правке для рецензента…"
                    value={draftCom}
                    onChange={noteField}
                    onKeyDown={onFieldKeyDown}
                    disabled={readOnly}
                  />
                  <SaveRow label="Сохранить" onSave={save} onCancel={() => setMode(null)} justSaved={justSaved} />
                </>
              )}
              {mode === 'delete' && (
                <>
                  <FragmentPicker
                    fragment={issue.source_fragment || ''}
                    value={draftTarget}
                    onChange={(t) => { setDraftTarget(t); setJustSaved(false); }}
                    label="Что удалить: выделите часть пункта или оставьте весь"
                    verb="удалить"
                    disabled={readOnly}
                  />
                  <div className="label mt-3">Примечание (необязательно)</div>
                  <textarea
                    ref={noteRef}
                    className="input min-h-[70px]"
                    placeholder="Пояснение к удалению для рецензента…"
                    value={draftCom}
                    onChange={noteField}
                    onKeyDown={onFieldKeyDown}
                    disabled={readOnly}
                  />
                  <SaveRow label="Удалить" danger onSave={save} onCancel={() => setMode(null)} justSaved={justSaved} />
                </>
              )}
              {mode === 'note' && (
                <>
                  <div className="label">Примечание</div>
                  <textarea
                    ref={noteRef}
                    className="input min-h-[100px]"
                    placeholder="Текст комментария к фрагменту…"
                    value={draftCom}
                    onChange={noteField}
                    onKeyDown={onFieldKeyDown}
                    disabled={readOnly}
                  />
                  <SaveRow label="Сохранить" onSave={save} onCancel={() => setMode(null)} justSaved={justSaved} />
                </>
              )}
              {!mode && (
                (effectiveDecision || issue.decision_comment || issue.decision_redaction) ? (
                  <>
                    {/* Сохранённое решение видно сразу при раскрытии (не нужно повторно
                        жать кнопку, чтобы прочитать своё примечание/правку). */}
                    <div className="label">Сохранённое решение</div>
                    <div className="p-2 bg-white border rounded text-sm space-y-1">
                      {decisionBadge && <div>Действие: <strong>{decisionBadge}</strong></div>}
                      {issue.decision_target_text && (
                        <div className="text-xs text-gray-600">Часть пункта: «{issue.decision_target_text}»</div>
                      )}
                      {issue.decision_redaction && (
                        <div className="text-xs"><span className="text-gray-500">Новый текст:</span> {issue.decision_redaction}</div>
                      )}
                      {issue.decision_comment ? (
                        <div className="text-xs whitespace-pre-wrap"><span className="text-gray-500">Примечание:</span> {issue.decision_comment}</div>
                      ) : (
                        <div className="text-xs text-gray-400">Без примечания.</div>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 mt-2 italic">
                      Нажмите «Изменить», «Удалить» или «Примечание», чтобы изменить решение.
                    </p>
                  </>
                ) : (
                  <p className="text-xs text-gray-500 italic">
                    Выберите действие: «Изменить», «Удалить» или «Примечание».
                  </p>
                )
              )}
            </div>
          </div>
        </td>
      </tr>
    </>
  );
}

// Строка сохранения раскрытой панели: одна явная кнопка (оба поля уходят вместе) +
// «Отмена». Подсказка по горячим клавишам и инлайн-индикатор «✓ Сохранено».
function SaveRow({ label, danger, onSave, onCancel, justSaved }) {
  return (
    <div className="flex items-center gap-2 mt-3 flex-wrap">
      <button
        type="button"
        className={`btn text-sm ${danger ? 'btn-danger' : 'btn-primary'}`}
        onClick={onSave}
      >
        {label}
      </button>
      <button type="button" className="btn btn-ghost text-sm" onClick={onCancel}>
        Отмена
      </button>
      {justSaved && <span className="text-xs text-emerald-700">✓ Сохранено</span>}
      <span className="text-xs text-gray-400 ml-auto">Ctrl+Enter — сохранить · Esc — закрыть</span>
    </div>
  );
}

// Выбор части фрагмента для delete/edit. Фрагмент показан в readOnly-textarea;
// инженер выделяет нужную часть (слово/предложение/фразу) — берём точную подстроку
// из того же текста (offsets совпадают). Пусто = действие на весь фрагмент.
function FragmentPicker({ fragment, value, onChange, label, verb = 'изменить', disabled }) {
  const ref = useRef(null);
  const capture = () => {
    const el = ref.current;
    if (!el) return;
    const s = el.selectionStart;
    const e = el.selectionEnd;
    if (s != null && e != null && e > s) onChange(fragment.slice(s, e));
  };
  return (
    <div>
      <div className="label">{label}</div>
      <textarea
        ref={ref}
        readOnly
        className="input min-h-[80px] bg-gray-50"
        value={fragment}
        onSelect={capture}
        onMouseUp={capture}
        onKeyUp={capture}
      />
      <div className="text-xs mt-1 flex items-center gap-2 flex-wrap">
        {value ? (
          <>
            <span className="text-gray-700">Будет {verb}: <strong>«{truncate(value, 90)}»</strong></span>
            {!disabled && (
              <button type="button" className="btn btn-ghost text-xs" onClick={() => onChange('')}>
                весь фрагмент
              </button>
            )}
          </>
        ) : (
          <span className="text-gray-500">Действие на весь фрагмент. Выделите часть, чтобы ограничить.</span>
        )}
      </div>
    </div>
  );
}
