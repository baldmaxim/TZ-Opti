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

  if (loading) return <div className="text-center text-gray-500 py-8">Загрузка…</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-semibold">Таблица характеристик</h2>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="tag bg-gray-100 text-gray-700">{items.length} шт.</span>
          {locked ? (
            <button className="btn btn-primary" onClick={handleEdit} disabled={busy}>
              {busy ? 'Открываю…' : '✎ Редактировать'}
            </button>
          ) : (
            <button className="btn btn-primary" onClick={handleSave} disabled={busy}>
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
            : 'Добавьте характеристики тендера: технические параметры, материалы, требования.'}
          action={!locked ? (
            <button className="btn btn-primary" onClick={handleAdd} disabled={busy}>
              + Добавить характеристику
            </button>
          ) : null}
        />
      ) : (
        <>
          <div className="card overflow-hidden">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="table-head w-12 text-center">№</th>
                  <th className="table-head min-w-[220px]">Название</th>
                  <th className="table-head min-w-[220px]">Значение</th>
                  <th className="table-head">Комментарий</th>
                  <th className="table-head w-10"></th>
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
                      <input
                        type="text"
                        className="input text-sm"
                        value={it.value || ''}
                        onChange={(e) => handleFieldChange(it.id, 'value', e.target.value)}
                        disabled={locked}
                      />
                    </td>
                    <td className="table-cell">
                      <input
                        type="text"
                        className="input text-sm"
                        value={it.comment || ''}
                        onChange={(e) => handleFieldChange(it.id, 'comment', e.target.value)}
                        disabled={locked}
                      />
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
