import { useState } from 'react';
import { TENDER_TYPES, TENDER_STATUSES } from '../../utils/labels';

const EMPTY = {
  title: '',
  customer: '',
  type: 'shell',
  stage: 'РД',
  deadline: '',
  owner: '',
  status: 'draft',
  description: '',
};

export default function TenderForm({ initial, onSubmit, onCancel }) {
  const [data, setData] = useState({ ...EMPTY, ...(initial || {}) });
  const [busy, setBusy] = useState(false);

  const set = (name, value) => setData((d) => ({ ...d, [name]: value }));

  const submit = async (e) => {
    e.preventDefault();
    if (!data.title.trim()) return;
    setBusy(true);
    try {
      await onSubmit(data);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label className="label">Название объекта *</label>
        <input className="input" value={data.title} onChange={(e) => set('title', e.target.value)} required />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="label">Заказчик</label>
          <input className="input" value={data.customer || ''} onChange={(e) => set('customer', e.target.value)} />
        </div>
        <div>
          <label className="label">Тип тендера</label>
          <select className="input" value={data.type || 'shell'} onChange={(e) => set('type', e.target.value)}>
            {Object.entries(TENDER_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Стадия проекта</label>
          <input className="input" placeholder="РД, П, П+РД…" value={data.stage || ''} onChange={(e) => set('stage', e.target.value)} />
        </div>
        <div>
          <label className="label">Срок подачи</label>
          <input className="input" type="date" value={data.deadline || ''} onChange={(e) => set('deadline', e.target.value)} />
        </div>
        <div>
          <label className="label">Ответственный</label>
          <input className="input" value={data.owner || ''} onChange={(e) => set('owner', e.target.value)} />
        </div>
        <div>
          <label className="label">Статус</label>
          <select className="input" value={data.status || 'draft'} onChange={(e) => set('status', e.target.value)}>
            {Object.entries(TENDER_STATUSES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
      </div>
      <div>
        <label className="label">Описание</label>
        <textarea className="input min-h-[80px]" value={data.description || ''} onChange={(e) => set('description', e.target.value)} />
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>Отмена</button>
        <button type="submit" className="btn btn-primary" disabled={busy || !data.title.trim()}>
          {busy ? 'Сохранение…' : 'Сохранить'}
        </button>
      </div>
    </form>
  );
}
