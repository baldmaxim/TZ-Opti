import { useEffect, useState } from 'react';
import { api } from '../../services/api';
import EditableTable from '../../components/tables/EditableTable';
import { toastError, toastSuccess } from '../../store/useToastStore';
import { useTenderStore } from '../../store/useTenderStore';

const COLUMNS = [
  { key: 'section', label: 'Раздел', type: 'text', width: '15%' },
  { key: 'work_name', label: 'Наименование работы', type: 'text' },
  { key: 'in_tz', label: 'ТЗ', type: 'checkbox' },
  { key: 'in_pd_rd', label: 'ПД/РД', type: 'checkbox' },
  { key: 'in_vor', label: 'ВОР', type: 'checkbox' },
  { key: 'in_calc', label: 'В расчёте', type: 'checkbox' },
  { key: 'in_kp', label: 'В КП', type: 'checkbox' },
  { key: 'in_contract', label: 'В договоре', type: 'checkbox' },
  { key: 'affects_schedule', label: 'Влияет на график', type: 'checkbox' },
  { key: 'comment', label: 'Комментарий', type: 'text' },
];

const EMPTY = { section: '', work_name: '', in_tz: false, in_pd_rd: false, in_vor: false, in_calc: false, in_kp: false, in_contract: false, affects_schedule: false, comment: '' };

export default function ChecklistTab({ tenderId }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const refreshTender = useTenderStore((s) => s.refreshTender);

  const load = async () => {
    setLoading(true);
    try {
      const data = await api.listChecklist(tenderId);
      setRows((data.items || []).map((r) => ({
        ...r,
        in_tz: !!r.in_tz, in_pd_rd: !!r.in_pd_rd, in_vor: !!r.in_vor,
        in_calc: !!r.in_calc, in_kp: !!r.in_kp, in_contract: !!r.in_contract,
        affects_schedule: !!r.affects_schedule,
      })));
    } catch (err) { toastError(err.message); }
    setLoading(false);
  };

  useEffect(() => { load(); }, [tenderId]);

  const handleUpdate = async (id, patch) => {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    try { await api.updateChecklist(tenderId, id, patch); }
    catch (err) { toastError(err.message); load(); }
  };
  const handleCreate = async (data) => {
    try {
      await api.createChecklist(tenderId, data);
      toastSuccess('Строка добавлена');
      await load(); await refreshTender();
    } catch (err) { toastError(err.message); }
  };
  const handleDelete = async (id) => {
    try { await api.deleteChecklist(tenderId, id); await load(); await refreshTender(); }
    catch (err) { toastError(err.message); }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-600">Чек-лист состава работ. Отмечайте, где работа учтена. Поля `ТЗ / ВОР` участвуют в Стадии 1 анализа.</p>
      <EditableTable
        columns={COLUMNS}
        rows={rows}
        loading={loading}
        onUpdate={handleUpdate}
        onCreate={handleCreate}
        onDelete={handleDelete}
        emptyRowTemplate={EMPTY}
      />
    </div>
  );
}
