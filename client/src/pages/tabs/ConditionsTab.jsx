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
  { key: 'category', label: 'Категория', type: 'text', width: '20%' },
  { key: 'condition', label: 'Условие', type: 'textarea' },
  { key: 'criticality', label: 'Критичность', type: 'select', options: CRIT, width: '15%' },
  { key: 'comment', label: 'Комментарий', type: 'text', width: '25%' },
];

const EMPTY = { category: '', condition: '', criticality: 'medium', comment: '' };

export default function ConditionsTab({ tenderId }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const data = await api.listConditions(tenderId);
      setRows(data.items || []);
    } catch (err) { toastError(err.message); }
    setLoading(false);
  };

  useEffect(() => { load(); }, [tenderId]);

  const handleUpdate = async (id, patch) => {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    try { await api.updateCondition(tenderId, id, patch); }
    catch (err) { toastError(err.message); load(); }
  };
  const handleCreate = async (data) => {
    try { await api.createCondition(tenderId, data); toastSuccess('Условие добавлено'); await load(); }
    catch (err) { toastError(err.message); }
  };
  const handleDelete = async (id) => {
    try { await api.deleteCondition(tenderId, id); await load(); }
    catch (err) { toastError(err.message); }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-600">Существенные условия компании как генподрядчика. Используются как ориентир при анализе.</p>
      <EditableTable columns={COLUMNS} rows={rows} loading={loading}
        onUpdate={handleUpdate} onCreate={handleCreate} onDelete={handleDelete}
        emptyRowTemplate={EMPTY} />
    </div>
  );
}
