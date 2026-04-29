import { useEffect, useRef, useState } from 'react';
import { api } from '../../services/api';
import { toastError, toastSuccess } from '../../store/useToastStore';
import { useTenderStore } from '../../store/useTenderStore';
import ParamsPanel from '../../components/conditions/ParamsPanel';
import ConditionsList from '../../components/conditions/ConditionsList';

const SECTION = 'conditions';

export default function ConditionsPage() {
  const tenderId = useTenderStore((s) => s.tenderId);
  const refreshTender = useTenderStore((s) => s.refreshTender);

  const [schema, setSchema] = useState(null);
  const [params, setParams] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  const debounceRef = useRef(null);

  const load = async () => {
    if (!tenderId) return;
    setLoading(true);
    try {
      const [schemaRes, paramsRes, condRes, locksRes] = await Promise.all([
        api.getSetupParamsSchema(tenderId),
        api.getSetupParams(tenderId),
        api.listConditions(tenderId),
        api.getSetupLocks(tenderId),
      ]);
      setSchema(schemaRes.schema || []);
      setParams(paramsRes.params || null);
      setItems(condRes.items || []);
      setLocked(!!locksRes.locks?.[SECTION]);
    } catch (err) { toastError(err.message); }
    setLoading(false);
  };

  const reloadConditions = async () => {
    try {
      const condRes = await api.listConditions(tenderId);
      setItems(condRes.items || []);
    } catch (err) { toastError(err.message); }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [tenderId]);

  const handleParamsChange = (next) => {
    if (locked) return;
    setParams(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        await api.updateSetupParams(tenderId, {
          escalation: next.escalation,
          advance: next.advance,
          build_months: next.build_months,
          transfer_months: next.transfer_months,
          kp_date: next.kp_date,
        });
        await reloadConditions();
      } catch (err) {
        toastError(err.message);
        load();
      }
    }, 350);
  };

  const handlePatchCondition = async (idx, patch) => {
    if (locked) return;
    try {
      await api.patchCondition(tenderId, idx, patch);
      // Локально обновим карту, не перезагружая всё.
      setItems((arr) => arr.map((it) => {
        if (it.idx !== idx) return it;
        const next = { ...it };
        if (Object.prototype.hasOwnProperty.call(patch, 'text_override')) {
          if (patch.text_override == null || patch.text_override === '') {
            next.text = it.text_template;
            next.isOverridden = false;
          } else {
            next.text = patch.text_override;
            next.isOverridden = true;
          }
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'comment')) next.comment = patch.comment ?? '';
        if (Object.prototype.hasOwnProperty.call(patch, 'criticality')) next.criticality = patch.criticality;
        return next;
      }));
    } catch (err) { toastError(err.message); load(); }
  };

  const handleResetOverride = async (idx) => {
    if (locked) return;
    try {
      await api.removeConditionOverride(tenderId, idx);
      setItems((arr) => arr.map((it) => (
        it.idx === idx
          ? { ...it, text: it.text_template, isOverridden: false }
          : it
      )));
    } catch (err) { toastError(err.message); }
  };

  const handleResetAll = async () => {
    if (locked) return;
    if (!confirm('Сбросить все ручные правки и комментарии? Параметры тендера сохранятся.')) return;
    setBusy(true);
    try {
      await api.resetConditions(tenderId);
      await reloadConditions();
      toastSuccess('Условия сброшены к шаблону');
    } catch (err) { toastError(err.message); }
    setBusy(false);
  };

  const handleSave = async () => {
    setBusy(true);
    try {
      await api.lockSetup(tenderId, SECTION);
      setLocked(true);
      toastSuccess('Условия сохранены');
      await refreshTender();
    } catch (err) { toastError(err.message); }
    setBusy(false);
  };

  const handleEdit = async () => {
    setBusy(true);
    try {
      await api.unlockSetup(tenderId, SECTION);
      setLocked(false);
      toastSuccess('Режим редактирования включён');
      await refreshTender();
    } catch (err) { toastError(err.message); }
    setBusy(false);
  };

  if (loading) return <div className="text-center text-gray-500 py-8">Загрузка…</div>;
  if (!params || !schema) return <div className="text-gray-500 text-sm">Нет данных.</div>;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Существенные условия компании</h2>
      </div>

      <ParamsPanel
        schema={schema}
        params={params}
        onChange={handleParamsChange}
        disabled={locked}
        footerAction={locked ? (
          <button className="btn btn-primary" onClick={handleEdit} disabled={busy}>
            {busy ? 'Открываю…' : '✎ Редактировать'}
          </button>
        ) : (
          <button className="btn btn-primary" onClick={handleSave} disabled={busy}>
            {busy ? 'Сохранение…' : '💾 Сохранить'}
          </button>
        )}
      />

      <ConditionsList
        items={items}
        locked={locked}
        onPatch={handlePatchCondition}
        onResetOverride={handleResetOverride}
      />

      {!locked && (
        <div>
          <button className="btn btn-ghost text-gray-600" onClick={handleResetAll} disabled={busy}>
            Сбросить все правки ↺
          </button>
        </div>
      )}

    </div>
  );
}
