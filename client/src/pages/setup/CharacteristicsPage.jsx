import { useEffect, useRef, useState } from 'react';
import { api } from '../../services/api';
import { toastError, toastSuccess } from '../../store/useToastStore';
import { useTenderStore } from '../../store/useTenderStore';
import EmptyState from '../../components/ui/EmptyState';

const SECTION = 'characteristics';

export default function CharacteristicsPage() {
  const tenderId = useTenderStore((s) => s.tenderId);
  const refreshTender = useTenderStore((s) => s.refreshTender);

  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  const debounceRef = useRef({});
  const textareaRefs = useRef({});

  const handleCommentKeyDown = (e, index) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    e.preventDefault();
    const next = items[index + 1];
    if (!next) return;
    const nextEl = textareaRefs.current[next.id];
    if (nextEl) {
      nextEl.focus();
      const len = nextEl.value.length;
      try { nextEl.setSelectionRange(len, len); } catch (_e) { /* ignore */ }
    }
  };

  const load = async () => {
    if (!tenderId) return;
    setLoading(true);
    try {
      const [list, locks] = await Promise.all([
        api.listCharacteristics(tenderId),
        api.getSetupLocks(tenderId),
      ]);
      setItems(list.items || []);
      setLocked(!!locks.locks?.[SECTION]);
    } catch (err) { toastError(err.message); }
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [tenderId]);

  const handleAdd = async () => {
    if (locked) return;
    setBusy(true);
    try {
      const created = await api.createCharacteristic(tenderId, { name: 'Новая характеристика' });
      setItems((arr) => [...arr, created]);
    } catch (err) { toastError(err.message); }
    setBusy(false);
  };

  const handleSeedTemplate = async () => {
    if (locked) return;
    setBusy(true);
    try {
      const r = await api.seedCharacteristics(tenderId);
      if (r && r.inserted > 0) toastSuccess(`Добавлено ${r.inserted} стандартных характеристик`);
      await load();
    } catch (err) { toastError(err.message); }
    setBusy(false);
  };

  const handleDelete = async (id) => {
    if (locked) return;
    if (!confirm('Удалить характеристику?')) return;
    try {
      await api.deleteCharacteristic(id);
      setItems((arr) => arr.filter((it) => it.id !== id));
    } catch (err) { toastError(err.message); load(); }
  };

  const handleFieldChange = (id, field, value) => {
    if (locked) return;
    setItems((arr) => arr.map((it) => (it.id === id ? { ...it, [field]: value } : it)));
    const key = `${id}__${field}`;
    clearTimeout(debounceRef.current[key]);
    debounceRef.current[key] = setTimeout(async () => {
      try { await api.updateCharacteristic(id, { [field]: value }); }
      catch (err) { toastError(err.message); load(); }
    }, 350);
  };

  const handleSave = async () => {
    setBusy(true);
    try {
      await api.lockSetup(tenderId, SECTION);
      setLocked(true);
      toastSuccess('Таблица характеристик сохранена');
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

  const handleClearComment = (id) => {
    handleFieldChange(id, 'comment', '');
  };

  const handleClearAllComments = async () => {
    if (locked) return;
    const dirty = items.filter((it) => (it.comment || '').trim());
    if (!dirty.length) return;
    if (!confirm(`Очистить комментарии у ${dirty.length} характеристик?`)) return;
    setItems((arr) => arr.map((it) => ({ ...it, comment: '' })));
    try {
      await Promise.all(dirty.map((it) => api.updateCharacteristic(it.id, { comment: null })));
    } catch (err) { toastError(err.message); load(); }
  };

  const hasAnyComment = items.some((it) => (it.comment || '').trim());

  if (loading) return <div className="text-center text-gray-500 py-8">Загрузка…</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-semibold">Таблица характеристик</h2>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {!locked && hasAnyComment && (
            <button
              className="btn btn-ghost text-gray-600"
              onClick={handleClearAllComments}
              title="Очистить комментарии у всех характеристик"
            >
              ✕ Очистить все
            </button>
          )}
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

      {items.length === 0 ? (
        <EmptyState
          title="Характеристики не заданы"
          description={locked
            ? 'Раздел сохранён без характеристик.'
            : 'Загрузите стандартный шаблон (32 характеристики) или добавьте вручную.'}
          action={!locked ? (
            <div className="flex gap-2 justify-center flex-wrap">
              <button className="btn btn-control" onClick={handleSeedTemplate} disabled={busy}>
                ⊕ Загрузить стандартный шаблон
              </button>
              <button className="btn btn-secondary" onClick={handleAdd} disabled={busy}>
                + Добавить характеристику
              </button>
            </div>
          ) : null}
        />
      ) : (
        <>
          <div className="card overflow-hidden">
            <table className="w-full table-fixed">
              <colgroup>
                <col className="w-12" />
                <col className="w-[38%]" />
                <col />
                <col className="w-10" />
              </colgroup>
              <thead>
                <tr className="bg-gray-50">
                  <th className="px-3 py-2.5 text-sm font-semibold text-gray-800 text-center">№</th>
                  <th className="px-3 py-2.5 text-sm font-semibold text-gray-800 text-center">Название</th>
                  <th className="px-3 py-2.5 text-sm font-semibold text-gray-800 text-center">Комментарии СУ-10</th>
                  <th className="px-3 py-2.5"></th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, idx) => (
                  <tr key={it.id} className="border-t border-gray-100 align-top">
                    <td className="table-cell text-gray-400 text-center">{idx + 1}</td>
                    <td className="table-cell">
                      <div className="text-sm font-medium text-gray-900 py-1.5 px-1" title="Название — константа, редактирование запрещено">
                        {it.name || '—'}
                      </div>
                    </td>
                    <td className="table-cell">
                      {locked ? (
                        <div className="text-sm text-gray-900 whitespace-pre-wrap py-1.5 px-1 leading-snug">
                          {it.comment ? it.comment : <span className="text-gray-400">—</span>}
                        </div>
                      ) : (
                        <div className="relative">
                          <textarea
                            ref={(el) => { textareaRefs.current[it.id] = el; }}
                            className="input text-sm leading-snug resize-y min-h-[40px] pr-7"
                            rows={2}
                            value={it.comment || ''}
                            onChange={(e) => handleFieldChange(it.id, 'comment', e.target.value)}
                            onKeyDown={(e) => handleCommentKeyDown(e, idx)}
                          />
                          {(it.comment || '').length > 0 && (
                            <button
                              type="button"
                              onClick={() => handleClearComment(it.id)}
                              className="absolute top-1.5 right-1.5 w-5 h-5 flex items-center justify-center rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100 text-xs leading-none"
                              title="Очистить поле"
                              tabIndex={-1}
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="table-cell text-right">
                      {!locked && (
                        <button
                          type="button"
                          onClick={() => handleDelete(it.id)}
                          className="text-gray-400 hover:text-red-600 text-lg leading-none"
                          title="Удалить"
                        >
                          ✕
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {!locked && (
            <div>
              <button className="btn btn-secondary" onClick={handleAdd} disabled={busy}>
                + Добавить характеристику
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
