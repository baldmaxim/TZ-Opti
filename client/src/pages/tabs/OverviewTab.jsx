import { useTenderStore } from '../../store/useTenderStore';
import { TENDER_TYPES, TENDER_STATUSES, STAGE_STATUS } from '../../utils/labels';
import { formatDate, formatDateTime } from '../../utils/format';

export default function OverviewTab() {
  const tender = useTenderStore((s) => s.tender);
  const stages = useTenderStore((s) => s.stages);
  if (!tender) return null;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Название">{tender.title}</Field>
        <Field label="Заказчик">{tender.customer || '—'}</Field>
        <Field label="Тип">{TENDER_TYPES[tender.type] || tender.type || '—'}</Field>
        <Field label="Стадия проекта">{tender.stage || '—'}</Field>
        <Field label="Срок подачи">{formatDate(tender.deadline)}</Field>
        <Field label="Ответственный">{tender.owner || '—'}</Field>
        <Field label="Статус">{TENDER_STATUSES[tender.status] || tender.status}</Field>
        <Field label="Создан">{formatDateTime(tender.created_at)}</Field>
      </div>
      {tender.description && (
        <div>
          <div className="text-xs font-medium text-gray-500 mb-1">Описание</div>
          <p className="text-sm text-gray-800 whitespace-pre-wrap">{tender.description}</p>
        </div>
      )}
      <div>
        <h3 className="font-semibold mb-2">Прогресс анализа</h3>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          {stages?.map((s) => (
            <div key={s.stage} className="p-3 border rounded-md bg-gray-50">
              <div className="text-xs text-gray-500">Стадия {s.stage}</div>
              <div className="font-medium text-sm">{s.label}</div>
              <div className="text-xs mt-1">{STAGE_STATUS[s.status] || s.status}</div>
              {s.summary?.summary && (
                <div className="text-xs text-gray-600 mt-1">Замечаний: {s.summary.summary.issues_count}</div>
              )}
            </div>
          ))}
        </div>
      </div>
      <div>
        <h3 className="font-semibold mb-2">Состояние данных</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <Stat label="Документы" value={tender.counts?.documents ?? 0} />
          <Stat label="Состав работ" value={tender.counts?.checklist ?? 0} />
          <Stat label="Условия компании" value={tender.counts?.conditions ?? 0} />
          <Stat label="Риски (с глобальными)" value={tender.counts?.risks ?? 0} />
          <Stat label="Замечаний всего" value={tender.counts?.issues_total ?? 0} />
          <Stat label="Замечаний на рассмотрении" value={tender.counts?.issues_pending ?? 0} />
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <div className="text-xs font-medium text-gray-500">{label}</div>
      <div className="text-sm text-gray-900 mt-0.5">{children}</div>
    </div>
  );
}
function Stat({ label, value }) {
  return (
    <div className="p-3 border rounded-md bg-white">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-xl font-semibold mt-1">{value}</div>
    </div>
  );
}
