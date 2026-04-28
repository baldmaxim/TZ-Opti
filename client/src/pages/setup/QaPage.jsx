import { useEffect, useRef, useState } from 'react';
import { api } from '../../services/api';
import { toastError, toastSuccess } from '../../store/useToastStore';
import EmptyState from '../../components/ui/EmptyState';
import { useTenderStore } from '../../store/useTenderStore';
import NextStepCta from '../../components/wizard/NextStepCta';

export default function QaPage() {
  const tenderId = useTenderStore((s) => s.tenderId);
  const refreshDocuments = useTenderStore((s) => s.refreshDocuments);
  const [characteristics, setCharacteristics] = useState([]);
  const [qaEntries, setQaEntries] = useState([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const fileRef = useRef(null);

  const load = async () => {
    if (!tenderId) return;
    setLoading(true);
    try {
      const [c, q] = await Promise.all([
        api.listCharacteristics(tenderId),
        api.listQa(tenderId),
      ]);
      setCharacteristics(c.items || []);
      setQaEntries(q.items || []);
    } catch (err) { toastError(err.message); }
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [tenderId]);

  const handleUpload = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      await api.uploadQa(tenderId, file);
      toastSuccess('Q&A форма загружена');
      if (fileRef.current) fileRef.current.value = '';
      await load();
      await refreshDocuments();
    } catch (err) { toastError(err.message); }
    setBusy(false);
  };

  const updateChar = async (id, field, value) => {
    setCharacteristics((cs) => cs.map((c) => (c.id === id ? { ...c, [field]: value } : c)));
    try { await api.updateCharacteristic(id, { [field]: value }); }
    catch (err) { toastError(err.message); load(); }
  };

  return (
    <div className="space-y-4">
      <div className="card p-4">
        <h3 className="font-semibold text-sm">Загрузка Q&A формы (.xlsx)</h3>
        <p className="text-xs text-gray-600 mt-1">
          Файл должен содержать колонки: <code>Вопрос | Ответ | Принятое решение | Источник характеристики | Значение</code>.
          Каждая загрузка <strong>полностью заменяет</strong> ранее загруженные характеристики.
        </p>
        <div className="mt-3 flex items-center gap-3 flex-wrap">
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls"
            onChange={(e) => handleUpload(e.target.files?.[0])}
            disabled={busy}
            className="block text-sm file:mr-3 file:py-2 file:px-3 file:rounded-md file:border-0 file:bg-brand-600 file:text-white file:cursor-pointer"
          />
          {busy && <span className="text-xs text-gray-500">Загрузка и парсинг…</span>}
        </div>
      </div>

      <div>
        <h4 className="font-semibold text-sm mb-2">Таблица характеристик ({characteristics.length})</h4>
        {loading ? (
          <div className="text-center py-6 text-gray-500">Загрузка…</div>
        ) : characteristics.length === 0 ? (
          <EmptyState
            title="Характеристики не загружены"
            description="Загрузите Q&A форму выше — характеристики появятся автоматически."
          />
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="table-head">Характеристика</th>
                  <th className="table-head">Значение</th>
                  <th className="table-head">Источник</th>
                  <th className="table-head">Комментарий</th>
                </tr>
              </thead>
              <tbody>
                {characteristics.map((c) => (
                  <tr key={c.id} className="border-t border-gray-100">
                    <td className="table-cell">
                      <input
                        className="input"
                        value={c.name || ''}
                        onChange={(e) => updateChar(c.id, 'name', e.target.value)}
                      />
                    </td>
                    <td className="table-cell">
                      <input
                        className="input"
                        value={c.value || ''}
                        onChange={(e) => updateChar(c.id, 'value', e.target.value)}
                      />
                    </td>
                    <td className="table-cell text-gray-500 text-xs whitespace-nowrap">{c.source || '—'}</td>
                    <td className="table-cell">
                      <input
                        className="input"
                        value={c.comment || ''}
                        onChange={(e) => updateChar(c.id, 'comment', e.target.value)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {qaEntries.length > 0 && (
        <details className="card p-4">
          <summary className="cursor-pointer font-medium text-sm">Исходные строки Q&A ({qaEntries.length})</summary>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr>
                  <th className="table-head">Вопрос</th>
                  <th className="table-head">Ответ</th>
                  <th className="table-head">Принятое решение</th>
                </tr>
              </thead>
              <tbody>
                {qaEntries.map((q) => (
                  <tr key={q.id} className="border-t border-gray-100">
                    <td className="table-cell">{q.question || '—'}</td>
                    <td className="table-cell text-gray-700">{q.answer || '—'}</td>
                    <td className="table-cell text-gray-700">{q.accepted_decision || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      <NextStepCta hint="Q&A форма — вход для Стадии 2 анализа. Загрузите её до запуска Стадии 2." />
    </div>
  );
}
