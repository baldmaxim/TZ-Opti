import { useEffect, useRef, useState } from 'react';
import { api } from '../../../services/api';
import { toastError, toastSuccess } from '../../../store/useToastStore';

export default function Stage2Card() {
  const [chars, setChars] = useState([]);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  // We need tenderId. The parent passes via context or prop. Read from URL.
  const tenderId = window.location.pathname.split('/')[2];

  const load = async () => {
    try {
      const data = await api.listCharacteristics(tenderId);
      setChars(data.items || []);
    } catch (err) { toastError(err.message); }
  };
  useEffect(() => { load(); }, []);

  const handleUpload = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      await api.uploadQa(tenderId, file);
      toastSuccess('Q&A форма загружена');
      if (fileRef.current) fileRef.current.value = '';
      await load();
    } catch (err) { toastError(err.message); }
    setBusy(false);
  };

  return (
    <div className="card p-4 bg-amber-50 border-amber-200">
      <h4 className="font-semibold text-sm">Q&A форма (вход для Стадии 2)</h4>
      <p className="text-xs text-gray-600 mt-1">
        Загрузите xlsx с заполненной Q&A формой. Колонки: <code>Вопрос | Ответ | Принятое решение | Источник характеристики | Значение</code>.
      </p>
      <div className="mt-3 flex items-center gap-3">
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.xls"
          onChange={(e) => handleUpload(e.target.files?.[0])}
          disabled={busy}
          className="block text-sm file:mr-3 file:py-1 file:px-3 file:rounded file:border-0 file:bg-brand-600 file:text-white"
        />
        {busy && <span className="text-xs text-gray-500">Загрузка…</span>}
      </div>
      {chars.length > 0 && (
        <div className="mt-4">
          <div className="text-xs font-medium text-gray-600 mb-1">Таблица характеристик ({chars.length}):</div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr>
                  <th className="table-head">Характеристика</th>
                  <th className="table-head">Значение</th>
                  <th className="table-head">Источник</th>
                </tr>
              </thead>
              <tbody>
                {chars.map((c) => (
                  <tr key={c.id} className="border-t border-gray-200">
                    <td className="table-cell">{c.name}</td>
                    <td className="table-cell">{c.value || '—'}</td>
                    <td className="table-cell text-gray-500">{c.source || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
