import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTendersStore } from '../store/useTendersStore';
import { TENDER_TYPES } from '../utils/labels';
import { withViewTransition } from '../utils/viewTransition';
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
  }, [load, filters.search, filters.type]);

  const handleCreate = async (data) => {
    const t = await create(data);
    setModalOpen(false);
    toastSuccess('Тендер создан');
    navigate(`/tenders/${t.id}`);
  };

  return (
    <div className="space-y-6">
      <div className="relative text-center">
        <h1 className="inline-block text-4xl font-semibold tracking-tight bg-gray-600 text-white px-10 pt-4 pb-6 rounded-lg leading-none">Дашборд тендеров</h1>
        <button
          className="absolute top-1/2 right-0 -translate-y-1/2 inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium bg-gray-900 text-white hover:bg-gray-800 transition"
          onClick={() => setModalOpen(true)}
        >
          Создать тендер
        </button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[260px]">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
            width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
          </svg>
          <input
            className="w-full pl-9 pr-3 py-2 text-[15px] bg-white border border-gray-200 rounded-md focus:border-gray-400 focus:ring-0 outline-none transition placeholder:text-gray-400"
            placeholder="Поиск по названию, заказчику…"
            value={filters.search}
            onChange={(e) => setFilter('search', e.target.value)}
          />
        </div>
        <select
          className="px-3 py-2 text-sm bg-white border border-gray-200 rounded-md focus:border-gray-400 focus:ring-0 outline-none text-gray-700"
          value={filters.type}
          onChange={(e) => setFilter('type', e.target.value)}
        >
          <option value="">Все типы</option>
          {Object.entries(TENDER_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-400 text-sm">Загрузка…</div>
      ) : items.length === 0 ? (
        <EmptyState
          title="Нет тендеров"
          description="Создайте первый тендер, чтобы начать анализ ТЗ."
          action={
            <button
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium bg-gray-900 text-white hover:bg-gray-800 transition"
              onClick={() => setModalOpen(true)}
            >
              Создать тендер
            </button>
          }
        />
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="pl-4 pr-2 py-3 text-xs font-medium text-gray-500 text-left w-10">№</th>
                <th className="px-4 py-3 text-xs font-medium text-gray-500 text-left">Тендер</th>
                <th className="px-4 py-3 text-xs font-medium text-gray-500 text-left">Заказчик</th>
                <th className="px-4 py-3 text-xs font-medium text-gray-500 text-right">Замечания</th>
                <th className="w-8"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((t, idx) => (
                <tr
                  key={t.id}
                  className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50/60 cursor-pointer transition"
                  onClick={() => withViewTransition('forward', () => navigate(`/tenders/${t.id}`))}
                >
                  <td className="pl-4 pr-2 py-3 align-top text-sm text-gray-400 tabular-nums">{idx + 1}</td>
                  <td className="px-4 py-3 align-top">
                    <div className="text-[15px] text-gray-900 font-medium">{t.title}</div>
                    <div className="text-xs text-gray-500 mt-0.5">{TENDER_TYPES[t.type] || t.type || '—'}</div>
                  </td>
                  <td className="px-4 py-3 align-top text-sm text-gray-600">{t.customer || '—'}</td>
                  <td className="px-4 py-3 align-top text-right">
                    {t.counts?.issues_pending ? (
                      <span className="text-sm text-amber-700">{t.counts.issues_pending} в работе</span>
                    ) : t.counts?.issues_total ? (
                      <span className="text-sm text-emerald-700">{t.counts.issues_total} готово</span>
                    ) : (
                      <span className="text-gray-300 text-sm">—</span>
                    )}
                  </td>
                  <td className="px-2 py-3 align-top text-right">
                    <button
                      type="button"
                      className="p-1 rounded text-gray-300 hover:text-red-600 hover:bg-red-50 transition"
                      title="Удалить тендер"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`Удалить тендер «${t.title}»?`)) remove(t.id);
                      }}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
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
