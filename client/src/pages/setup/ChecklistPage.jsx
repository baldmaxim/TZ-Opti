import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { api } from '../../services/api';
import { toastError, toastSuccess } from '../../store/useToastStore';
import { useTenderStore } from '../../store/useTenderStore';
import EmptyState from '../../components/ui/EmptyState';

const SECTION = 'checklist';

function statusOf(row) {
  if (row.in_calc === 1) return 'yes';
  if (row.in_calc === 0) return 'no';
  return 'unknown';
}

export default function ChecklistPage() {
  const tenderId = useTenderStore((s) => s.tenderId);
  const refreshTender = useTenderStore((s) => s.refreshTender);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);

  const load = async () => {
    if (!tenderId) return;
    setLoading(true);
    try {
      const [{ items }, { locks }] = await Promise.all([
        api.listChecklist(tenderId),
        api.getSetupLocks(tenderId),
      ]);
      setRows(items || []);
      setLocked(!!locks?.[SECTION]);
    } catch (err) { toastError(err.message); }
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [tenderId]);

  const guardLocked = () => {
    if (locked) {
      toastError('Раздел сохранён. Нажмите «Редактировать», чтобы внести правки.');
      return true;
    }
    return false;
  };

  const setStatus = async (id, status) => {
    if (guardLocked()) return;
    const value = status === 'yes' ? 1 : status === 'no' ? 0 : null;
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, in_calc: value } : r)));
    try { await api.updateChecklist(tenderId, id, { in_calc: value }); }
    catch (err) { toastError(err.message); load(); }
  };

  const setComment = async (id, comment) => {
    if (locked) return; // молча игнорим (UI уже disabled)
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, comment } : r)));
    try { await api.updateChecklist(tenderId, id, { comment }); }
    catch (err) { toastError(err.message); }
  };

  const addCustom = async () => {
    if (guardLocked()) return;
    const name = prompt('Название работы');
    if (!name || !name.trim()) return;
    try {
      await api.createChecklist(tenderId, { section: 'Прочее', work_name: name.trim() });
      toastSuccess('Строка добавлена');
      await load();
    } catch (err) { toastError(err.message); }
  };

  const removeRow = async (id, name) => {
    if (guardLocked()) return;
    if (!confirm(`Удалить «${name}» из чек-листа?`)) return;
    try {
      await api.deleteChecklist(tenderId, id);
      await load();
    } catch (err) { toastError(err.message); }
  };

  const resetToStandard = async () => {
    if (guardLocked()) return;
    if (!confirm('Сбросить чек-лист к стандартному списку? Все ваши ответы и пользовательские строки будут удалены.')) return;
    setBusy(true);
    try {
      await api.resetChecklistToStandard(tenderId);
      toastSuccess('Чек-лист сброшен к стандартному списку');
      await load();
      await refreshTender();
    } catch (err) { toastError(err.message); }
    setBusy(false);
  };

  const handleSave = async () => {
    setBusy(true);
    try {
      await api.lockSetup(tenderId, SECTION);
      setLocked(true);
      toastSuccess('Чек-лист сохранён');
      await refreshTender();
    } catch (err) { toastError(err.message); }
    setBusy(false);
  };

  const handleEdit = async () => {
    setBusy(true);
    try {
      await api.unlockSetup(tenderId, SECTION);
      setLocked(false);
      toastSuccess('Режим редактирования включён');
      await refreshTender();
    } catch (err) { toastError(err.message); }
    setBusy(false);
  };

  const sections = useMemo(() => {
    const order = [];
    const map = new Map();
    rows.forEach((r) => {
      const key = r.section || 'Прочее';
      if (!map.has(key)) { map.set(key, []); order.push(key); }
      map.get(key).push(r);
    });
    return order.map((s) => ({ section: s, items: map.get(s) }));
  }, [rows]);

  const stats = useMemo(() => {
    const total = rows.length;
    let yes = 0, no = 0, unknown = 0;
    for (const r of rows) {
      const s = statusOf(r);
      if (s === 'yes') yes++; else if (s === 'no') no++; else unknown++;
    }
    return { total, yes, no, unknown };
  }, [rows]);

  if (loading) return <div className="text-center text-gray-500 py-8">Загрузка…</div>;

  if (!rows.length) {
    return (
      <EmptyState
        title="Чек-лист пуст"
        description="Заполните стандартным списком работ, чтобы начать."
        action={
          <button className="btn btn-primary" onClick={resetToStandard} disabled={busy}>
            Загрузить стандартный список
          </button>
        }
      />
    );
  }

  let counter = 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-semibold">Состав работ</h2>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Stat label="Учтено" count={stats.yes} cls="bg-green-100 text-green-800" />
          <Stat label="Не учтено" count={stats.no} cls="bg-red-100 text-red-800" />
          <Stat label="Не указано" count={stats.unknown} cls="bg-gray-100 text-gray-600" />
          {locked ? (
            <button className="btn btn-control" onClick={handleEdit} disabled={busy}>
              {busy ? 'Открываю…' : '✎ Редактировать'}
            </button>
          ) : (
            <button className="btn btn-control" onClick={handleSave} disabled={busy}>
              {busy ? 'Сохранение…' : '💾 Сохранить'}
            </button>
          )}
        </div>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full">
          <thead>
            <tr>
              <th className="table-head w-12 text-center">№</th>
              <th className="table-head">Наименование работы</th>
              <th className="table-head w-44">Статус</th>
              <th className="table-head">Примечание</th>
              <th className="table-head w-8"></th>
            </tr>
          </thead>
          <tbody>
            {sections.map(({ section, items }) => (
              <SectionRows
                key={section}
                section={section}
                items={items}
                startIdx={counter}
                onAdvanceCounter={() => { counter += items.length; }}
                onSetStatus={setStatus}
                onSetComment={setComment}
                onRemove={removeRow}
                locked={locked}
              />
            ))}
          </tbody>
        </table>
      </div>

      {!locked && (
        <div className="flex gap-2">
          <button className="btn btn-secondary" onClick={addCustom} disabled={busy}>
            + Добавить свою работу
          </button>
          <button
            className="btn btn-ghost text-gray-600"
            onClick={resetToStandard}
            disabled={busy}
            title="Сбросить к стандартному списку"
          >
            Сбросить ↺
          </button>
        </div>
      )}

    </div>
  );
}

function SectionRows({ section, items, startIdx, onSetStatus, onSetComment, onRemove, locked }) {
  return (
    <>
      <tr className="bg-gray-50">
        <td colSpan={5} className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">
          {section}
        </td>
      </tr>
      {items.map((r, idx) => (
        <ChecklistRow
          key={r.id}
          num={startIdx + idx + 1}
          row={r}
          onSetStatus={onSetStatus}
          onSetComment={onSetComment}
          onRemove={onRemove}
          locked={locked}
        />
      ))}
    </>
  );
}

function ChecklistRow({ num, row, onSetStatus, onSetComment, onRemove, locked }) {
  const status = statusOf(row);
  const rowClass =
    status === 'yes' ? 'bg-green-50' :
    status === 'no' ? 'bg-red-50' : '';
  return (
    <tr className={clsx('border-t border-gray-100', rowClass)}>
      <td className="table-cell text-center text-gray-500 font-mono text-xs">{num}</td>
      <td className="table-cell font-medium">{row.work_name}</td>
      <td className="table-cell">
        <StatusToggle status={status} onChange={(s) => onSetStatus(row.id, s)} disabled={locked} />
      </td>
      <td className="table-cell">
        {locked ? (
          <span className="text-sm text-gray-700">{row.comment || <span className="text-gray-400">—</span>}</span>
        ) : (
          <input
            className="input"
            placeholder="—"
            value={row.comment || ''}
            onChange={(e) => onSetComment(row.id, e.target.value)}
            disabled={locked}
          />
        )}
      </td>
      <td className="table-cell text-right">
        {!locked && (
          <button
            type="button"
            className="text-red-600 hover:text-red-800 text-sm px-1.5"
            onClick={() => onRemove(row.id, row.work_name)}
            title="Удалить строку"
            aria-label="Удалить"
          >×</button>
        )}
      </td>
    </tr>
  );
}

function StatusToggle({ status, onChange, disabled }) {
  return (
    <div
      className={clsx(
        'inline-flex rounded-md border border-gray-300 overflow-hidden text-xs',
        disabled && 'opacity-70'
      )}
    >
      <button
        type="button"
        className={clsx(
          'px-3 py-1.5 font-medium transition',
          status === 'yes' ? 'bg-green-600 text-white' : 'bg-white text-gray-700',
          !disabled && 'hover:bg-green-50',
          disabled && 'cursor-not-allowed'
        )}
        onClick={() => !disabled && onChange('yes')}
        disabled={disabled}
      >Да</button>
      <button
        type="button"
        className={clsx(
          'px-3 py-1.5 font-medium border-l border-gray-300 transition',
          status === 'no' ? 'bg-red-600 text-white' : 'bg-white text-gray-700',
          !disabled && 'hover:bg-red-50',
          disabled && 'cursor-not-allowed'
        )}
        onClick={() => !disabled && onChange('no')}
        disabled={disabled}
      >Нет</button>
      <button
        type="button"
        className={clsx(
          'px-2 py-1.5 font-medium border-l border-gray-300 transition text-gray-500',
          status === 'unknown' ? 'bg-gray-200' : 'bg-white',
          !disabled && 'hover:bg-gray-50',
          disabled && 'cursor-not-allowed'
        )}
        onClick={() => !disabled && onChange('unknown')}
        title="Сбросить статус"
        disabled={disabled}
      >—</button>
    </div>
  );
}

function Stat({ label, count, cls }) {
  return (
    <span className={clsx('tag whitespace-nowrap', cls)}>
      {label}: <strong className="ml-1">{count}</strong>
    </span>
  );
}
