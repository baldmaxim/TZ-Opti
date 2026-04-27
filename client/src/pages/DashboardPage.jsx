import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTendersStore } from '../store/useTendersStore';
import { TENDER_TYPES, TENDER_STATUSES, statusClass, criticalityClass } from '../utils/labels';
import { formatDate } from '../utils/format';
import Modal from '../components/ui/Modal';
import TenderForm from '../components/tender/TenderForm';
import EmptyState from '../components/ui/EmptyState';
import { toastSuccess } from '../store/useToastStore';

export default function DashboardPage() {
  const items = useTendersStore((s) => s.items);
  const loading = useTendersStore((s) => s.loading);
  const filters = useTendersStore((s) => s.filters);
  const setFilter = useTendersStore((s) => s.setFilter);
  const load = useTendersStore((s) => s.load);
  const create = useTendersStore((s) => s.create);
  const remove = useTendersStore((s) => s.remove);
  const [modalOpen, setModalOpen] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    load();
  }, [load, filters.search, filters.status, filters.type]);

  const handleCreate = async (data) => {
    const t = await create(data);
    setModalOpen(false);
    toastSuccess('Тендер создан');
    navigate(`/tenders/${t.id}`);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Тендеры</h1>
          <p className="text-sm text-gray-500">Реестр тендеров на СМР с прогрессом анализа ТЗ.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setModalOpen(true)}>+ Создать тендер</button>
      </div>

      <div className="card p-4 grid grid-cols-1 md:grid-cols-3 gap-3">
        <div>
          <label className="label">Поиск</label>
          <input
            className="input"
            placeholder="Название, заказчик, описание…"
            value={filters.search}
            onChange={(e) => setFilter('search', e.target.value)}
          />
        </div>
        <div>
          <label className="label">Статус</label>
          <select className="input" value={filters.status} onChange={(e) => setFilter('status', e.target.value)}>
            <option value="">Все статусы</option>
            {Object.entries(TENDER_STATUSES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Тип</label>
          <select className="input" value={filters.type} onChange={(e) => setFilter('type', e.target.value)}>
            <option value="">Все типы</option>
            {Object.entries(TENDER_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-8 text-gray-500">Загрузка…</div>
      ) : items.length === 0 ? (
        <EmptyState
          title="Нет тендеров"
          description="Создайте первый тендер, чтобы начать анализ ТЗ."
          action={<button className="btn btn-primary" onClick={() => setModalOpen(true)}>Создать тендер</button>}
        />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="table-head">Название</th>
                <th className="table-head">Заказчик</th>
                <th className="table-head">Тип</th>
                <th className="table-head">Стадия</th>
                <th className="table-head">Срок</th>
                <th className="table-head">Статус</th>
                <th className="table-head">Документы</th>
                <th className="table-head">Замечания</th>
                <th className="table-head"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.id} className="border-t border-gray-100 hover:bg-gray-50 cursor-pointer" onClick={() => navigate(`/tenders/${t.id}`)}>
                  <td className="table-cell font-medium">{t.title}</td>
                  <td className="table-cell text-gray-600">{t.customer || '—'}</td>
                  <td className="table-cell">{TENDER_TYPES[t.type] || t.type || '—'}</td>
                  <td className="table-cell">{t.stage || '—'}</td>
                  <td className="table-cell">{formatDate(t.deadline)}</td>
                  <td className="table-cell">
                    <span className={`tag ${statusClass(t.status)}`}>{TENDER_STATUSES[t.status] || t.status}</span>
                  </td>
                  <td className="table-cell">{t.counts?.documents ?? 0}</td>
                  <td className="table-cell">
                    {t.counts?.issues_pending ? (
                      <span className={`tag ${criticalityClass('high')}`}>{t.counts.issues_pending} в работе</span>
                    ) : <span className="text-gray-400">—</span>}
                  </td>
                  <td className="table-cell">
                    <button
                      className="btn btn-ghost text-red-600"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`Удалить тендер «${t.title}»?`)) remove(t.id);
                      }}
                    >Удалить</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Создать тендер" size="lg">
        <TenderForm onSubmit={handleCreate} onCancel={() => setModalOpen(false)} />
      </Modal>
    </div>
  );
}
