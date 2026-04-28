import { useEffect, useState } from 'react';
import { api } from '../../services/api';
import { TENDER_TYPES } from '../../utils/labels';
import { toastError, toastSuccess } from '../../store/useToastStore';
import { useTenderStore } from '../../store/useTenderStore';
import NextStepCta from '../../components/wizard/NextStepCta';

const FIELDS = [
  { key: 'tender_type', label: 'Тип тендера', kind: 'select' },
  { key: 'package_scope', label: 'Состав пакета', kind: 'textarea' },
  { key: 'terms', label: 'Сроки', kind: 'text' },
  { key: 'staging', label: 'Этапность', kind: 'textarea' },
  { key: 'blocks_sections', label: 'Корпуса / секции', kind: 'text' },
  { key: 'site_constraints', label: 'Ограничения площадки', kind: 'textarea' },
  { key: 'special_conditions', label: 'Особые условия', kind: 'textarea' },
  { key: 'comment', label: 'Комментарий', kind: 'textarea' },
];

export default function ObjectInfoPage() {
  const tenderId = useTenderStore((s) => s.tenderId);
  const [data, setData] = useState({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!tenderId) return;
    api.getObjectInfo(tenderId).then(setData).catch((err) => toastError(err.message));
  }, [tenderId]);

  const set = (k, v) => setData((d) => ({ ...d, [k]: v }));

  const save = async () => {
    setBusy(true);
    try {
      const next = await api.saveObjectInfo(tenderId, data);
      setData(next);
      toastSuccess('Сохранено');
    } catch (err) { toastError(err.message); }
    setBusy(false);
  };

  return (
    <div className="space-y-4 max-w-4xl">
      <p className="text-sm text-gray-600">Дополнительная информация по объекту: пакет работ, сроки, этапность, ограничения.</p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {FIELDS.map((f) => (
          <div key={f.key} className={f.kind === 'textarea' ? 'md:col-span-2' : ''}>
            <label className="label">{f.label}</label>
            {f.kind === 'select' ? (
              <select className="input" value={data[f.key] || ''} onChange={(e) => set(f.key, e.target.value)}>
                <option value="">—</option>
                {Object.entries(TENDER_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            ) : f.kind === 'textarea' ? (
              <textarea className="input min-h-[80px]" value={data[f.key] || ''} onChange={(e) => set(f.key, e.target.value)} />
            ) : (
              <input className="input" value={data[f.key] || ''} onChange={(e) => set(f.key, e.target.value)} />
            )}
          </div>
        ))}
      </div>
      <div className="flex justify-end">
        <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? 'Сохранение…' : 'Сохранить'}</button>
      </div>
      <NextStepCta />
    </div>
  );
}
