import { useEffect, useState } from 'react';
import { api } from '../../services/api';
import EditableTable from '../../components/tables/EditableTable';
import { toastError, toastSuccess } from '../../store/useToastStore';

const CRIT = [
  { value: 'low', label: 'Низкая' },
  { value: 'medium', label: 'Средняя' },
  { value: 'high', label: 'Высокая' },
  { value: 'critical', label: 'Критическая' },
];

const COLUMNS = [
  { key: 'category', label: 'Категория', type: 'text', width: '15%' },
  { key: 'risk_text', label: 'Формулировка риска', type: 'textarea' },
  { key: 'recommendation', label: 'Типовая рекомендация', type: 'textarea' },
  { key: 'criticality', label: 'Критичность', type: 'select', options: CRIT, width: '12%' },
];

const EMPTY = { category: '', risk_text: '', recommendation: '', criticality: 'medium' };

export default function RisksTab({ tenderId }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const data = await api.listRisks(tenderId);
      setRows(data.items || []);
    } catch (err) { toastError(err.message); }
    setLoading(false);
  };

  useEffect(() => { load(); }, [tenderId]);

  const handleUpdate = async (id, patch) => {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    try { await api.updateRisk(tenderId, id, patch); }
    catch (err) { toastError(err.message); load(); }
  };
  const handleCreate = async (data) => {
    try { await api.createRisk(tenderId, data); toastSuccess('Риск добавлен'); await load(); }
    catch (err) { toastError(err.message); }
  };
  const handleDelete = async (id) => {
    try { await api.deleteRisk(tenderId, id); await load(); }
    catch (err) { toastError(err.message); }
  };

  const localRows = rows.filter((r) => !r.is_global);
  const globalRows = rows.filter((r) => r.is_global);

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600">База типовых рисков. Глобальные риски применяются ко всем тендерам, локальные — только к этому.</p>
      {globalRows.length > 0 && (
        <div>
          <h4 className="font-semibold text-sm mb-2">Глобальные риски (read-only)</h4>
          <div className="card overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="table-head">Категория</th>
                  <th className="table-head">Формулировка</th>
                  <th className="table-head">Рекомендация</th>
                  <th className="table-head">Критичность</th>
                </tr>
              </thead>
              <tbody>
                {globalRows.map((r) => (
                  <tr key={r.id} className="border-t border-gray-100">
                    <td className="table-cell">{r.category}</td>
                    <td className="table-cell text-gray-700">{r.risk_text}</td>
                    <td className="table-cell text-gray-700">{r.recommendation || '—'}</td>
                    <td className="table-cell">{r.criticality}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <h4 className="font-semibold text-sm">Риски этого тендера</h4>
      <EditableTable columns={COLUMNS} rows={localRows} loading={loading}
        onUpdate={handleUpdate} onCreate={handleCreate} onDelete={handleDelete}
        emptyRowTemplate={EMPTY} />
    </div>
  );
}
