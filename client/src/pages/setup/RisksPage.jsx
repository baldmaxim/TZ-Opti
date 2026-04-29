import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { api } from '../../services/api';
import { toastError, toastSuccess } from '../../store/useToastStore';
import { useTenderStore } from '../../store/useTenderStore';
import Modal from '../../components/ui/Modal';

const SECTION = 'risks';

const CRIT_LABEL = {
  low: 'Низкая',
  medium: 'Средняя',
  high: 'Высокая',
  critical: 'Критическая',
};

const CRIT_CLASS = {
  low: 'bg-blue-100 text-blue-800',
  medium: 'bg-amber-100 text-amber-800',
  high: 'bg-orange-100 text-orange-800',
  critical: 'bg-red-100 text-red-800',
};

function appliesValue(r) {
  if (r.applies === 1) return 'yes';
  if (r.applies === 0) return 'no';
  return 'auto';
}

export default function RisksPage() {
  const tenderId = useTenderStore((s) => s.tenderId);
  const refreshTender = useTenderStore((s) => s.refreshTender);
  const [items, setItems] = useState([]);
  const [matches, setMatches] = useState({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  const [filter, setFilter] = useState('all');
  const [showAddModal, setShowAddModal] = useState(false);

  const load = async () => {
    if (!tenderId) return;
    setLoading(true);
    try {
      const [risksRes, matchesRes, locksRes] = await Promise.all([
        api.listRisks(tenderId),
        api.getRiskMatches(tenderId).catch(() => ({ matches: {} })),
        api.getSetupLocks(tenderId),
      ]);
      setItems(risksRes.items || []);
      setMatches(matchesRes.matches || {});
      setLocked(!!locksRes.locks?.[SECTION]);
    } catch (err) { toastError(err.message); }
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [tenderId]);

  const setApplies = async (key, val) => {
    if (locked) return;
    const applies = val === 'yes' ? 1 : val === 'no' ? 0 : null;
    setItems((arr) => arr.map((r) => (
      r.key === key
        ? { ...r, applies, effective: applies != null ? applies === 1 : r.apply_default }
        : r
    )));
    try { await api.patchRiskState(tenderId, key, { applies }); }
    catch (err) { toastError(err.message); load(); }
  };

  const setComment = async (key, comment) => {
    if (locked) return;
    setItems((arr) => arr.map((r) => (r.key === key ? { ...r, comment } : r)));
    try { await api.patchRiskState(tenderId, key, { comment }); }
    catch (err) { toastError(err.message); }
  };

  const handleReset = async () => {
    if (locked) return;
    if (!confirm('Сбросить все ваши пометки «Применять / Не применять» и комментарии? Будет действовать автоматический выбор.')) return;
    setBusy(true);
    try {
      await api.resetRisks(tenderId);
      await load();
      toastSuccess('Пометки сброшены');
    } catch (err) { toastError(err.message); }
    setBusy(false);
  };

  const handleSave = async () => {
    setBusy(true);
    try {
      await api.lockSetup(tenderId, SECTION);
      setLocked(true);
      toastSuccess('Риски сохранены');
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

  const handleCreateCustom = async (data) => {
    try {
      await api.createCustomRisk(tenderId, data);
      toastSuccess('Свой риск добавлен');
      setShowAddModal(false);
      await load();
    } catch (err) { toastError(err.message); }
  };

  const handleDeleteCustom = async (customId, riskText) => {
    if (!confirm(`Удалить свой риск «${riskText}»?`)) return;
    try {
      await api.deleteCustomRisk(tenderId, customId);
      toastSuccess('Удалено');
      await load();
    } catch (err) { toastError(err.message); }
  };

  const visibleItems = useMemo(() => {
    if (filter === 'active') return items.filter((r) => r.effective);
    if (filter === 'matches') return items.filter((r) => matches[r.key] && matches[r.key].count > 0);
    return items;
  }, [items, matches, filter]);

  const sections = useMemo(() => {
    const order = [];
    const map = new Map();
    visibleItems.forEach((r) => {
      const key = r.category || 'Прочее';
      if (!map.has(key)) { map.set(key, []); order.push(key); }
      map.get(key).push(r);
    });
    return order.map((s) => ({ section: s, items: map.get(s) }));
  }, [visibleItems]);

  const stats = useMemo(() => {
    let yes = 0, no = 0, auto = 0, withMatches = 0, customCount = 0;
    for (const r of items) {
      if (r.applies === 1) yes++;
      else if (r.applies === 0) no++;
      else auto++;
      if (matches[r.key] && matches[r.key].count) withMatches++;
      if (r.is_custom) customCount++;
    }
    return { yes, no, auto, withMatches, customCount, total: items.length };
  }, [items, matches]);

  if (loading) return <div className="text-center text-gray-500 py-8">Загрузка…</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-semibold">База типовых рисков</h2>
          <p className="text-sm text-gray-600 mt-0.5">
            {stats.total} рисков ({stats.total - stats.customCount} стандартных + {stats.customCount} своих).
            Используется в Стадии 3 анализа.
          </p>
        </div>
        {locked ? (
          <button className="btn btn-control" onClick={handleEdit} disabled={busy}>
            {busy ? 'Открываю…' : '✎ Редактировать'}
          </button>
        ) : (
          <button className="btn btn-control" onClick={handleSave} disabled={busy}>
            {busy ? 'Сохранение…' : '💾 Сохранить'}
          </button>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <span className="tag bg-green-100 text-green-800">Применять: <strong className="ml-1">{stats.yes}</strong></span>
        <span className="tag bg-red-100 text-red-800">Не применять: <strong className="ml-1">{stats.no}</strong></span>
        <span className="tag bg-gray-100 text-gray-700">Авто: <strong className="ml-1">{stats.auto}</strong></span>
        {stats.withMatches > 0 && (
          <span
            className="tag bg-amber-100 text-amber-800"
            title="Сколько рисков нашли совпадения в активном тексте ТЗ"
          >⚡ В ТЗ: <strong className="ml-1">{stats.withMatches}</strong></span>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-gray-500">Показать:</span>
        <FilterButton active={filter === 'all'} onClick={() => setFilter('all')}>
          Все ({items.length})
        </FilterButton>
        <FilterButton active={filter === 'active'} onClick={() => setFilter('active')}>
          Только активные ({items.filter((r) => r.effective).length})
        </FilterButton>
        <FilterButton active={filter === 'matches'} onClick={() => setFilter('matches')}>
          С совпадениями в ТЗ ({stats.withMatches})
        </FilterButton>
        <div className="flex-1" />
        {!locked && (
          <button className="btn btn-secondary" onClick={() => setShowAddModal(true)}>
            + Свой риск
          </button>
        )}
      </div>

      <div className="space-y-3">
        {sections.map(({ section, items: secItems }) => (
          <div key={section} className="card overflow-hidden">
            <div className="bg-gray-50 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500 border-b">
              {section} <span className="text-gray-400 normal-case">({secItems.length})</span>
            </div>
            <table className="w-full table-fixed">
              <thead>
                <tr>
                  <th className="table-head">Риск и триггеры</th>
                  <th className="table-head w-32">В ТЗ</th>
                  <th className="table-head w-44">Применять</th>
                </tr>
              </thead>
              <tbody>
                {secItems.map((r) => (
                  <RiskRow
                    key={r.key}
                    risk={r}
                    match={matches[r.key]}
                    locked={locked}
                    onApplies={(v) => setApplies(r.key, v)}
                    onComment={(v) => setComment(r.key, v)}
                    onDeleteCustom={() => handleDeleteCustom(r.custom_id, r.risk_text)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>

      {!locked && (
        <div>
          <button className="btn btn-ghost text-gray-600" onClick={handleReset} disabled={busy}>
            Сбросить пометки ↺
          </button>
        </div>
      )}

      <AddCustomRiskModal
        open={showAddModal}
        existingCategories={[...new Set(items.map((r) => r.category))]}
        onClose={() => setShowAddModal(false)}
        onSubmit={handleCreateCustom}
      />
    </div>
  );
}

function FilterButton({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'px-2.5 py-1 rounded text-xs font-medium border transition',
        active
          ? 'bg-brand-600 text-white border-brand-700'
          : 'bg-white text-gray-700 border-gray-300 hover:border-brand-400'
      )}
    >{children}</button>
  );
}

function RiskRow({ risk, match, locked, onApplies, onComment, onDeleteCustom }) {
  const [showSamples, setShowSamples] = useState(false);
  const v = appliesValue(risk);
  const matchCount = match ? match.count : 0;

  return (
    <tr className={clsx('border-t border-gray-100 align-top', !risk.effective && 'opacity-60')}>
      <td className={clsx('table-cell', risk.effective ? 'border-l-2 border-green-500' : 'border-l-2 border-gray-200')}>
        <div className="flex items-start gap-2">
          <span className={clsx('tag flex-shrink-0', CRIT_CLASS[risk.criticality] || 'bg-gray-100')}>
            {CRIT_LABEL[risk.criticality] || risk.criticality}
          </span>
          {risk.is_custom && (
            <span className="tag bg-purple-100 text-purple-800 flex-shrink-0" title="Свой риск (добавлен вручную)">★ Свой</span>
          )}
          <div className="flex-1 min-w-0">
            <div className="font-medium text-sm whitespace-pre-wrap break-words">{risk.risk_text}</div>
            {(risk.triggers || []).length > 0 && (
              <div className="text-xs text-gray-500 mt-1">
                <span className="text-gray-400">триггеры:</span>{' '}
                {risk.triggers.map((t, i) => (
                  <span key={i} className="font-mono bg-gray-100 text-gray-700 rounded px-1 mr-1 mb-0.5 inline-block">
                    {t}
                  </span>
                ))}
              </div>
            )}
          </div>
          {risk.is_custom && !locked && (
            <button
              type="button"
              className="text-red-600 hover:text-red-800 text-sm px-1"
              title="Удалить свой риск"
              onClick={onDeleteCustom}
            >×</button>
          )}
        </div>
      </td>
      <td className="table-cell">
        {matchCount > 0 ? (
          <div>
            <button
              type="button"
              className="tag bg-amber-100 text-amber-800 cursor-pointer hover:bg-amber-200"
              onClick={() => setShowSamples((s) => !s)}
              title="Показать цитаты"
            >⚡ {matchCount} совп.</button>
            {showSamples && match.samples && (
              <div className="mt-2 space-y-1">
                {match.samples.map((s, i) => (
                  <div key={i} className="text-[11px] bg-yellow-50 border-l-2 border-yellow-400 px-2 py-1">
                    п. {s.paragraph_index + 1}: «{s.full_paragraph}»
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <span className="text-xs text-gray-400">—</span>
        )}
      </td>
      <td className="table-cell">
        <ApplyToggle value={v} autoSuggest={risk.apply_default} onChange={onApplies} disabled={locked} />
        {!locked && (
          <textarea
            className="input min-h-[40px] text-xs mt-2"
            placeholder="комментарий (необязательно)"
            value={risk.comment || ''}
            onChange={(e) => onComment(e.target.value)}
            disabled={locked}
          />
        )}
        {locked && risk.comment && (
          <div className="text-xs text-gray-700 mt-2">{risk.comment}</div>
        )}
      </td>
    </tr>
  );
}

function ApplyToggle({ value, autoSuggest, onChange, disabled }) {
  return (
    <div className={clsx('inline-flex rounded-md border border-gray-300 overflow-hidden text-xs', disabled && 'opacity-70')}>
      <button
        type="button"
        className={clsx(
          'px-2 py-1 font-medium transition',
          value === 'yes' ? 'bg-green-600 text-white' : 'bg-white text-gray-700',
          !disabled && 'hover:bg-green-50',
          disabled && 'cursor-not-allowed'
        )}
        onClick={() => !disabled && onChange('yes')}
        disabled={disabled}
      >Да</button>
      <button
        type="button"
        className={clsx(
          'px-2 py-1 font-medium border-l border-gray-300 transition',
          value === 'no' ? 'bg-red-600 text-white' : 'bg-white text-gray-700',
          !disabled && 'hover:bg-red-50',
          disabled && 'cursor-not-allowed'
        )}
        onClick={() => !disabled && onChange('no')}
        disabled={disabled}
      >Нет</button>
      <button
        type="button"
        className={clsx(
          'px-2 py-1 font-medium border-l border-gray-300 transition',
          value === 'auto' ? 'bg-gray-200 text-gray-800' : 'bg-white text-gray-500',
          !disabled && 'hover:bg-gray-50',
          disabled && 'cursor-not-allowed'
        )}
        onClick={() => !disabled && onChange('auto')}
        title={`Автовыбор: ${autoSuggest ? 'Да' : 'Нет'}`}
        disabled={disabled}
      >Авто {autoSuggest ? '✓' : '✗'}</button>
    </div>
  );
}

function AddCustomRiskModal({ open, existingCategories, onClose, onSubmit }) {
  const [category, setCategory] = useState('');
  const [riskText, setRiskText] = useState('');
  const [triggers, setTriggers] = useState('');
  const [criticality, setCriticality] = useState('medium');
  const [busy, setBusy] = useState(false);

  // Сброс при открытии
  useEffect(() => {
    if (open) {
      setCategory('');
      setRiskText('');
      setTriggers('');
      setCriticality('medium');
      setBusy(false);
    }
  }, [open]);

  const submit = async (e) => {
    e.preventDefault();
    if (!riskText.trim()) return;
    setBusy(true);
    await onSubmit({
      category: category.trim() || 'Прочее',
      risk_text: riskText.trim(),
      triggers: triggers
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean),
      criticality,
    });
    setBusy(false);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Добавить свой риск"
      size="lg"
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={busy}>Отмена</button>
          <button
            className="btn btn-primary"
            onClick={submit}
            disabled={busy || !riskText.trim()}
          >{busy ? 'Сохранение…' : 'Добавить'}</button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="label">Категория</label>
          <input
            className="input"
            list="categories-list"
            placeholder="Например: Прочее"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          />
          <datalist id="categories-list">
            {existingCategories.map((c) => <option key={c} value={c} />)}
          </datalist>
          <p className="text-xs text-gray-500 mt-1">Можно выбрать существующую или ввести свою.</p>
        </div>
        <div>
          <label className="label">Формулировка риска *</label>
          <textarea
            className="input min-h-[80px]"
            value={riskText}
            onChange={(e) => setRiskText(e.target.value)}
            required
            placeholder="Что плохо в этой формулировке ТЗ?"
          />
        </div>
        <div>
          <label className="label">Триггерные фразы</label>
          <textarea
            className="input min-h-[80px] font-mono text-xs"
            value={triggers}
            onChange={(e) => setTriggers(e.target.value)}
            placeholder={'по одной фразе на строку\nили через запятую'}
          />
          <p className="text-xs text-gray-500 mt-1">
            Stage 3 анализа будет искать эти фразы в активном тексте ТЗ.
          </p>
        </div>
        <div>
          <label className="label">Критичность</label>
          <select
            className="input"
            value={criticality}
            onChange={(e) => setCriticality(e.target.value)}
          >
            <option value="low">Низкая</option>
            <option value="medium">Средняя</option>
            <option value="high">Высокая</option>
            <option value="critical">Критическая</option>
          </select>
        </div>
      </form>
    </Modal>
  );
}
