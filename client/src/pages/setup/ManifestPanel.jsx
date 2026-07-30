import { useEffect, useState } from 'react';
import { api } from '../../services/api';
import { formatDateTime } from '../../utils/format';
import { toastError, toastSuccess } from '../../store/useToastStore';

// Манифест тендерного пакета: все документы тендера по типам, с редакцией,
// статусом актуальности, датой, приоритетом при противоречии, применимостью
// (корпус/раздел) и цепочкой замены. Правки уходят PATCH-ем по документу.

const STATUS_OPTIONS = [
  { value: 'actual', label: 'Актуальный' },
  { value: 'informational', label: 'Информационный' },
  { value: 'superseded', label: 'Заменён' },
];

const STATUS_BADGE = {
  actual: 'bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300',
  informational: 'bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-300',
  superseded: 'bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-400',
};

const statusLabel = (v) => STATUS_OPTIONS.find((o) => o.value === v)?.label || v;

export default function ManifestPanel({ tenderId, reloadKey = 0, onChanged }) {
  const [manifest, setManifest] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    if (!tenderId) return;
    setLoading(true);
    try {
      setManifest(await api.getManifest(tenderId));
    } catch (err) { toastError(err.message); }
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [tenderId, reloadKey]);

  if (!manifest || !manifest.total) return null;

  const handleSaved = async () => {
    await load();
    if (onChanged) await onChanged();
  };

  return (
    <div className="card p-4 space-y-3">
      <div>
        <h3 className="font-semibold">Манифест тендерного пакета</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
          Редакции, статусы актуальности и приоритеты документов. Анализ берёт только
          актуальные документы; «Заменён» исключается, «Информационный» уступает актуальному.
        </p>
      </div>

      {manifest.warnings?.length > 0 && (
        <ul className="text-xs text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded p-2 space-y-0.5">
          {manifest.warnings.map((w, i) => <li key={i}>⚠ {w.message}</li>)}
        </ul>
      )}

      <div className="space-y-3">
        {manifest.groups.map((g) => (
          <div key={g.doc_type}>
            <div className="text-xs font-semibold text-gray-600 dark:text-gray-300 uppercase tracking-wide mb-1">
              {g.label}
              <span className="ml-1.5 font-normal text-gray-400">
                {g.active_count}/{g.documents.length} актуальн.
              </span>
            </div>
            <div className="space-y-1.5">
              {g.documents.map((d) => (
                <ManifestRow
                  key={d.id}
                  doc={d}
                  groupDocs={g.documents}
                  disabled={loading}
                  onSaved={handleSaved}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ManifestRow({ doc, groupDocs, disabled, onSaved }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(() => ({
    revision_label: doc.revision_label || '',
    actuality_status: doc.actuality_status || 'actual',
    doc_date: doc.doc_date || '',
    conflict_priority: doc.conflict_priority ?? '',
    applicability: doc.applicability || '',
    supersedes_document_id: doc.supersedes_document_id || '',
  }));

  const set = (key) => (e) => setDraft((s) => ({ ...s, [key]: e.target.value }));

  const save = async () => {
    setBusy(true);
    try {
      await api.updateDocumentManifest(doc.id, {
        revision_label: draft.revision_label || null,
        actuality_status: draft.actuality_status,
        doc_date: draft.doc_date || null,
        conflict_priority: draft.conflict_priority === '' ? null : Number(draft.conflict_priority),
        applicability: draft.applicability || null,
        supersedes_document_id: draft.supersedes_document_id || null,
      });
      toastSuccess('Манифест обновлён');
      setOpen(false);
      await onSaved();
    } catch (err) { toastError(err.message); }
    setBusy(false);
  };

  const meta = [
    doc.revision_label,
    doc.applicability,
    doc.doc_date,
    doc.conflict_priority !== null && doc.conflict_priority !== undefined ? `приоритет ${doc.conflict_priority}` : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-2.5 py-1.5">
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium break-all" title={doc.name}>{doc.name}</div>
          <div className="text-[11px] text-gray-500 dark:text-gray-400">
            {formatDateTime(doc.uploaded_at)}
            {meta && <span className="ml-1.5">· {meta}</span>}
            {doc.superseded_by?.length > 0 && <span className="ml-1.5">· заменён новой редакцией</span>}
          </div>
        </div>
        <span className={`text-[11px] px-1.5 py-0.5 rounded-full whitespace-nowrap ${STATUS_BADGE[doc.manifest_status] || ''}`}>
          {statusLabel(doc.manifest_status)}
        </span>
        <button
          type="button"
          className="btn btn-secondary text-xs"
          onClick={() => setOpen((v) => !v)}
          disabled={disabled || busy}
        >
          {open ? 'Свернуть' : 'Изменить'}
        </button>
      </div>

      {open && (
        <div className="mt-2 grid grid-cols-2 md:grid-cols-3 gap-2 text-xs border-t border-gray-100 dark:border-gray-700 pt-2">
          <label className="flex flex-col gap-0.5">
            <span className="text-gray-500 dark:text-gray-400">Редакция</span>
            <input className="input" value={draft.revision_label} onChange={set('revision_label')} placeholder="редакция 3" />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-gray-500 dark:text-gray-400">Статус</span>
            <select className="input" value={draft.actuality_status} onChange={set('actuality_status')}>
              {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-gray-500 dark:text-gray-400">Дата документа</span>
            <input className="input" type="date" value={draft.doc_date} onChange={set('doc_date')} />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-gray-500 dark:text-gray-400">Приоритет при противоречии</span>
            <input className="input" type="number" value={draft.conflict_priority} onChange={set('conflict_priority')} placeholder="больше = важнее" />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-gray-500 dark:text-gray-400">Применимость (корпус/раздел)</span>
            <input className="input" value={draft.applicability} onChange={set('applicability')} placeholder="корпус 1" />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-gray-500 dark:text-gray-400">Заменяет документ</span>
            <select className="input" value={draft.supersedes_document_id} onChange={set('supersedes_document_id')}>
              <option value="">—</option>
              {groupDocs.filter((d) => d.id !== doc.id).map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </label>
          <div className="col-span-2 md:col-span-3 flex justify-end">
            <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>
              {busy ? 'Сохранение…' : 'Сохранить'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
