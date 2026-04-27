import { useEffect } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { useTenderStore } from '../store/useTenderStore';
import { TENDER_TYPES, TENDER_STATUSES, statusClass } from '../utils/labels';
import { formatDate } from '../utils/format';
import OverviewTab from './tabs/OverviewTab';
import DocumentsTab from './tabs/DocumentsTab';
import ChecklistTab from './tabs/ChecklistTab';
import ConditionsTab from './tabs/ConditionsTab';
import RisksTab from './tabs/RisksTab';
import ObjectInfoTab from './tabs/ObjectInfoTab';
import StagesTab from './tabs/StagesTab';
import ReviewTab from './tabs/ReviewTab';
import ExportTab from './tabs/ExportTab';

const TABS = [
  { id: 'overview', label: 'Обзор', component: OverviewTab },
  { id: 'documents', label: 'Документы', component: DocumentsTab },
  { id: 'checklist', label: 'Состав работ', component: ChecklistTab },
  { id: 'conditions', label: 'Условия компании', component: ConditionsTab },
  { id: 'risks', label: 'База рисков', component: RisksTab },
  { id: 'object', label: 'Доп. информация', component: ObjectInfoTab },
  { id: 'stages', label: 'Стадии анализа', component: StagesTab },
  { id: 'review', label: 'Рецензия', component: ReviewTab },
  { id: 'export', label: 'Экспорт', component: ExportTab },
];

export default function TenderPage() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const setTender = useTenderStore((s) => s.setTender);
  const tender = useTenderStore((s) => s.tender);
  const loading = useTenderStore((s) => s.loading);

  const tab = params.get('tab') || 'overview';

  useEffect(() => {
    setTender(id);
  }, [id, setTender]);

  if (loading || !tender) return <div className="py-12 text-center text-gray-500">Загрузка…</div>;

  const ActiveComponent = TABS.find((t) => t.id === tab)?.component || OverviewTab;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <Link to="/" className="text-xs text-gray-500 hover:text-gray-700">← К списку тендеров</Link>
          <h1 className="text-2xl font-semibold mt-1">{tender.title}</h1>
          <div className="flex items-center gap-3 text-sm text-gray-600 mt-1 flex-wrap">
            <span>{tender.customer || '—'}</span>
            <span>•</span>
            <span>{TENDER_TYPES[tender.type] || tender.type || '—'}</span>
            <span>•</span>
            <span>Стадия: {tender.stage || '—'}</span>
            <span>•</span>
            <span>Срок: {formatDate(tender.deadline)}</span>
            <span className={`tag ${statusClass(tender.status)}`}>{TENDER_STATUSES[tender.status] || tender.status}</span>
          </div>
        </div>
      </div>

      <div className="card overflow-x-auto">
        <div className="flex border-b">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setParams({ tab: t.id })}
              className={`px-4 py-2 text-sm font-medium whitespace-nowrap border-b-2 ${
                tab === t.id
                  ? 'border-brand-600 text-brand-700'
                  : 'border-transparent text-gray-600 hover:text-gray-900'
              }`}
            >{t.label}</button>
          ))}
        </div>
        <div className="p-4">
          <ActiveComponent tenderId={id} />
        </div>
      </div>
    </div>
  );
}
