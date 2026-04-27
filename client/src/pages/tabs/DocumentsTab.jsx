import { useEffect, useState, useRef } from 'react';
import { api } from '../../services/api';
import { DOC_TYPES } from '../../utils/labels';
import { formatDateTime } from '../../utils/format';
import { toastError, toastSuccess } from '../../store/useToastStore';
import EmptyState from '../../components/ui/EmptyState';
import { useTenderStore } from '../../store/useTenderStore';

export default function DocumentsTab({ tenderId }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [docType, setDocType] = useState('tz');
  const [comment, setComment] = useState('');
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef(null);
  const refreshTender = useTenderStore((s) => s.refreshTender);

  const load = async () => {
    setLoading(true);
    try {
      const data = await api.listDocuments(tenderId);
      setItems(data.items || []);
    } catch (err) { toastError(err.message); }
    setLoading(false);
  };

  useEffect(() => { load(); }, [tenderId]);

  const handleUpload = async (file) => {
    if (!file) return;
    setUploading(true);
    try {
      await api.uploadDocument(tenderId, file, docType, comment);
      toastSuccess('Документ загружен');
      setComment('');
      if (inputRef.current) inputRef.current.value = '';
      await load();
      await refreshTender();
    } catch (err) {
      toastError(err.message);
    }
    setUploading(false);
  };

  const handleDelete = async (id) => {
    if (!confirm('Удалить документ?')) return;
    try {
      await api.deleteDocument(id);
      toastSuccess('Документ удалён');
      await load();
      await refreshTender();
    } catch (err) { toastError(err.message); }
  };

  return (
    <div className="space-y-4">
      <div className="card p-4">
        <h3 className="font-semibold mb-3">Загрузка документа</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <label className="label">Тип документа</label>
            <select className="input" value={docType} onChange={(e) => setDocType(e.target.value)}>
              {Object.entries(DOC_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Комментарий (необязательно)</label>
            <input className="input" value={comment} onChange={(e) => setComment(e.target.value)} />
          </div>
          <div className="flex items-end">
            <input
              ref={inputRef}
              type="file"
              accept=".docx,.doc,.pdf,.xlsx,.xls,.txt,.md,.csv"
              onChange={(e) => handleUpload(e.target.files?.[0])}
              disabled={uploading}
              className="block w-full text-sm file:mr-3 file:py-2 file:px-3 file:rounded-md file:border-0 file:bg-brand-600 file:text-white file:cursor-pointer"
            />
          </div>
        </div>
        {uploading && <p className="text-xs text-gray-500 mt-2">Загрузка и извлечение текста…</p>}
      </div>

      {loading ? (
        <div className="text-center py-8 text-gray-500">Загрузка…</div>
      ) : items.length === 0 ? (
        <EmptyState title="Нет документов" description="Загрузите ТЗ, ПД/РД, ВОР и сопутствующие материалы." />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="table-head">Тип</th>
                <th className="table-head">Имя файла</th>
                <th className="table-head">Версия</th>
                <th className="table-head">Загружен</th>
                <th className="table-head">Статус</th>
                <th className="table-head">Комментарий</th>
                <th className="table-head"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((d) => (
                <tr key={d.id} className="border-t border-gray-100">
                  <td className="table-cell"><span className="tag bg-blue-100 text-blue-800">{DOC_TYPES[d.doc_type] || d.doc_type}</span></td>
                  <td className="table-cell font-medium">{d.name}</td>
                  <td className="table-cell">{d.version || '—'}</td>
                  <td className="table-cell text-gray-600">{formatDateTime(d.uploaded_at)}</td>
                  <td className="table-cell">
                    <span className={`tag ${d.processing_status === 'extracted' ? 'bg-green-100 text-green-800' : d.processing_status === 'failed' ? 'bg-red-100 text-red-800' : 'bg-gray-100 text-gray-700'}`}>
                      {d.processing_status === 'extracted' ? 'текст извлечён' : d.processing_status === 'failed' ? 'ошибка' : d.processing_status}
                    </span>
                  </td>
                  <td className="table-cell text-gray-600">{d.comment || '—'}</td>
                  <td className="table-cell text-right whitespace-nowrap">
                    <a href={api.documentDownloadUrl(d.id)} className="btn btn-ghost text-brand-700">Скачать</a>
                    <button className="btn btn-ghost text-red-600" onClick={() => handleDelete(d.id)}>Удалить</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
