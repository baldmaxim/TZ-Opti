import clsx from 'clsx';
import { useTenderStore } from '../../store/useTenderStore';
import { TENDER_TYPES, TENDER_STATUSES, statusClass } from '../../utils/labels';
import { formatDate } from '../../utils/format';

export default function MiniTenderHeader() {
  const tender = useTenderStore((s) => s.tender);
  if (!tender) return null;

  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-sm sticky top-[60px] z-20">
      <div className="px-4 py-3 flex items-center gap-3">
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
