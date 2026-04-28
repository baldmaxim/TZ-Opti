import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTendersStore } from '../store/useTendersStore';
import { TENDER_TYPES, TENDER_STATUSES, statusClass } from '../utils/labels';
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

      <div className="card p-3 flex items-center gap-3 flex-wrap">
        <input
          className="input flex-1 min-w-[220px]"
          placeholder="🔍 Поиск по названию, заказчику…"
          value={filters.search}
          onChange={(e) => setFilter('search', e.target.value)}
        />
        <select className="input w-auto" value={filters.status} onChange={(e) => setFilter('status', e.target.value)}>
          <option value="">Все статусы</option>
          {Object.entries(TENDER_STATUSES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select className="input w-auto" value={filters.type} onChange={(e) => setFilter('type', e.target.value)}>
          <option value="">Все типы</option>
          {Object.entries(TENDER_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
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
                <th className="table-head">Тендер</th>
                <th className="table-head">Заказчик</th>
                <th className="table-head">Срок</th>
                <th className="table-head">Статус</th>
                <th className="table-head text-right">Замечания</th>
                <th className="table-head w-8"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.id} className="border-t border-gray-100 hover:bg-gray-50 cursor-pointer" onClick={() => navigate(`/tenders/${t.id}`)}>
                  <td className="table-cell">
                    <div className="font-medium">{t.title}</div>
                    <div className="text-xs text-gray-500 mt-0.5">{TENDER_TYPES[t.type] || t.type || '—'}</div>
                  </td>
                  <td className="table-cell text-gray-600">{t.customer || '—'}</td>
                  <td className="table-cell text-gray-600">{formatDate(t.deadline)}</td>
                  <td className="table-cell">
                    <span className={`tag ${statusClass(t.status)}`}>{TENDER_STATUSES[t.status] || t.status}</span>
                  </td>
                  <td className="table-cell text-right">
                    {t.counts?.issues_pending ? (
                      <span className="tag bg-amber-100 text-amber-800">{t.counts.issues_pending} pending</span>
                    ) : t.counts?.issues_total ? (
                      <span className="tag bg-green-100 text-green-800">✓ {t.counts.issues_total}</span>
                    ) : (
                      <span className="text-gray-400 text-xs">—</span>
                    )}
                  </td>
                  <td className="table-cell text-right">
                    <button
                      className="btn btn-ghost text-red-600 text-xs"
                      title="Удалить тендер"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`Удалить тендер «${t.title}»?`)) remove(t.id);
                      }}
                    >✕</button>
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
