import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { useTenderStore } from '../../store/useTenderStore';
import { TENDER_TYPES, TENDER_STATUSES, statusClass } from '../../utils/labels';
import { formatDate } from '../../utils/format';

export default function MiniTenderHeader({ sidebarCollapsed, onToggleSidebar, onOpenDrawer }) {
  const tender = useTenderStore((s) => s.tender);
  if (!tender) return null;

  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-sm sticky top-[60px] z-20">
      <div className="px-4 py-3 flex items-center gap-3">
        <button
          className="lg:hidden p-1.5 rounded border border-gray-200 hover:bg-gray-50"
          onClick={onOpenDrawer}
          aria-label="Открыть навигацию"
          title="Навигация"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M2 4h12v1.5H2zM2 7.25h12v1.5H2zM2 10.5h12V12H2z"/></svg>
        </button>
        <button
          className="hidden lg:inline-flex p-1.5 rounded border border-gray-200 hover:bg-gray-50 text-gray-600"
          onClick={onToggleSidebar}
          aria-label={sidebarCollapsed ? 'Развернуть навигацию' : 'Свернуть навигацию'}
          title={sidebarCollapsed ? 'Развернуть навигацию' : 'Свернуть навигацию'}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            {sidebarCollapsed ? (
              <path d="M5.5 4l4 4-4 4V4z"/>
            ) : (
              <path d="M10.5 4l-4 4 4 4V4z"/>
            )}
          </svg>
        </button>
        <Link to="/" className="text-xs text-gray-500 hover:text-gray-700 whitespace-nowrap">← К списку</Link>

        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold leading-tight truncate">{tender.title}</h1>
          <div className="text-xs text-gray-500 mt-0.5 flex items-center gap-1.5 flex-wrap">
            <span className="truncate">{tender.customer || '—'}</span>
            <span className="text-gray-300">•</span>
            <span>{TENDER_TYPES[tender.type] || tender.type || '—'}</span>
            <span className="text-gray-300">•</span>
            <span>Срок: {formatDate(tender.deadline)}</span>
          </div>
        </div>

        <span className={clsx('tag whitespace-nowrap', statusClass(tender.status))}>
          {TENDER_STATUSES[tender.status] || tender.status}
        </span>
      </div>
    </div>
  );
}
