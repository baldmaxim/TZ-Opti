import { useEffect } from 'react';
import { useParams, Outlet, useLocation } from 'react-router-dom';
import { useTenderStore } from '../../store/useTenderStore';
import MiniTenderHeader from './MiniTenderHeader';

export default function TenderShell() {
  const { id } = useParams();
  const location = useLocation();
  const setTender = useTenderStore((s) => s.setTender);
  const tender = useTenderStore((s) => s.tender);

  useEffect(() => { setTender(id); }, [id, setTender]);

  if (!tender) {
    return <div className="py-12 text-center text-gray-500">Загрузка…</div>;
  }

  const isOverview = location.pathname.replace(/\/$/, '') === `/tenders/${id}`;
  if (isOverview) {
    return <Outlet />;
  }

  return (
    <div className="space-y-3">
      <MiniTenderHeader />
      <main>
        <Outlet />
      </main>
    </div>
  );
}
