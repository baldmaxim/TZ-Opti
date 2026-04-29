import { useEffect, useState } from 'react';
import { useParams, Outlet, useLocation } from 'react-router-dom';
import clsx from 'clsx';
import { useTenderStore } from '../../store/useTenderStore';
import MiniTenderHeader from './MiniTenderHeader';
import WizardSidebar from './WizardSidebar';

const COLLAPSED_KEY = 'tz-opti.sidebar.collapsed';

export default function TenderShell() {
  const { id } = useParams();
  const location = useLocation();
  const setTender = useTenderStore((s) => s.setTender);
  const tender = useTenderStore((s) => s.tender);

  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSED_KEY) === '1'; } catch { return false; }
  });
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => { setTender(id); }, [id, setTender]);

  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    try { localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0'); } catch { /* ignore */ }
  };

  if (!tender) {
    return <div className="py-12 text-center text-gray-500">Загрузка…</div>;
  }

  const isOverview = location.pathname.replace(/\/$/, '') === `/tenders/${id}`;
  if (isOverview) {
    return <Outlet />;
  }

  return (
    <div className="space-y-3">
      <MiniTenderHeader
        sidebarCollapsed={collapsed}
        onToggleSidebar={toggleCollapsed}
        onOpenDrawer={() => setDrawerOpen(true)}
      />

      <div className="flex gap-4 items-start">
        <aside
          className={clsx(
            'hidden lg:block flex-shrink-0 transition-all',
            collapsed ? 'w-[60px]' : 'w-[240px]'
          )}
        >
          <div className="sticky top-[140px]">
            <WizardSidebar collapsed={collapsed} />
          </div>
        </aside>

        <main className="flex-1 min-w-0">
          <Outlet />
        </main>
      </div>

      {drawerOpen && (
        <div className="lg:hidden fixed inset-0 z-40 flex">
          <div className="absolute inset-0 bg-black/40" onClick={() => setDrawerOpen(false)} />
          <div className="relative bg-white w-[280px] max-w-[80vw] h-full overflow-y-auto p-4 shadow-xl">
            <button
              className="text-sm text-gray-500 mb-3"
              onClick={() => setDrawerOpen(false)}
            >✕ Закрыть</button>
            <WizardSidebar collapsed={false} onNavigate={() => setDrawerOpen(false)} />
          </div>
        </div>
      )}
    </div>
  );
}
