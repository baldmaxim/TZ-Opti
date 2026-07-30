import { useEffect, useState } from 'react';
import { api } from '../../services/api';
import { DECISIONS } from '../../utils/labels';
import { formatTzClause } from '../../utils/format';
import { toastError, toastSuccess } from '../../store/useToastStore';

// Панель переноса решений между прогонами. После пересборки конвейера кластеры
// получают новые (run-scoped) id, поэтому решения прошлого прогона НЕ переносятся
// автоматически. Здесь инженер видит предложения (решение прошлого прогона →
// кластер нового) и ЯВНО подтверждает выбранные. Ничего не применяется без выбора.

const MATCH_LABEL = {
  exact: { text: 'Точное совпадение', cls: 'bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-300' },
  place: { text: 'По месту ТЗ', cls: 'bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-300' },
  text: { text: 'По тексту', cls: 'bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-300' },
};

// Ключ выбора = id решения прошлого прогона.
function keyOf(p) { return p.decision && p.decision.id; }

export default function CarryoverPanel({ tenderId, onConfirmed }) {
  const [proposals, setProposals] = useState([]);
  const [materialized, setMaterialized] = useState([]);
  const [selected, setSelected] = useState({}); // { [decisionId]: true }
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    if (!tenderId) return;
    try {
      const data = await api.listCarryovers(tenderId);
      const list = data.proposals || [];
      setProposals(list);
      setMaterialized(data.materialized || []);
      // По умолчанию отмечаем только точные совпадения без конфликта — остальное
      // инженер включает осознанно.
      const init = {};
      for (const p of list) if (p.match === 'exact' && !p.conflict) init[keyOf(p)] = true;
      setSelected(init);
      setLoaded(true);
    } catch (err) { toastError(err.message); }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [tenderId]);

  const toggle = (id) => setSelected((s) => ({ ...s, [id]: !s[id] }));

  const confirm = async () => {
    const selections = proposals
      .filter((p) => selected[keyOf(p)] && p.cluster_id)
      .map((p) => ({ decision_id: p.decision.id, cluster_id: p.cluster_id }));
    if (!selections.length) { toastError('Отметьте хотя бы один перенос'); return; }
    setBusy(true);
    try {
      const res = await api.confirmCarryovers(tenderId, selections);
      toastSuccess(`Перенесено решений: ${res.applied || 0}`);
      await load();
      if (onConfirmed) await onConfirmed();
    } catch (err) { toastError(err.message); }
    setBusy(false);
  };

  if (!loaded || (!proposals.length && !materialized.length)) return null;

  const selectedCount = proposals.filter((p) => selected[keyOf(p)]).length;

  return (
    <div className="card p-4 space-y-3 border-amber-300 dark:border-amber-700 bg-amber-50/60 dark:bg-amber-900/20">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="font-semibold text-sm text-amber-900 dark:text-amber-200">
            Перенос решений из прошлого прогона
          </div>
          <div className="text-xs text-gray-600 dark:text-gray-400">
            Итог пересобран — решения прежнего прогона не применяются автоматически.
            Отметьте, какие перенести на новые кластеры, и подтвердите.
          </div>
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-400">Предложений: {proposals.length}</div>
      </div>

      <div className="space-y-2">
        {proposals.map((p) => {
          const id = keyOf(p);
          const m = MATCH_LABEL[p.match] || null;
          const target = p.cluster || {};
          const clause = formatTzClause(target.tz_clause);
          return (
            <label
              key={id}
              className="flex items-start gap-3 p-2 rounded border dark:border-gray-700 bg-white dark:bg-gray-800 cursor-pointer"
            >
              <input
                type="checkbox"
                className="mt-1"
                checked={!!selected[id]}
                onChange={() => toggle(id)}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="tag bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 text-xs">
                    Решение: {DECISIONS[p.decision.decision] || p.decision.decision}
                  </span>
                  {m && <span className={`tag text-[10px] ${m.cls}`}>{m.text}</span>}
                  {p.conflict && (
                    <span className="tag text-[10px] bg-amber-200 dark:bg-amber-800 text-amber-900 dark:text-amber-200">
                      конфликт: несколько решений на кластер
                    </span>
                  )}
                </div>
                <div className="text-sm text-gray-800 dark:text-gray-100 mt-1 truncate">
                  → {target.cluster_title || clause || 'кластер нового прогона'}
                </div>
                {p.decision.final_comment && (
                  <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 truncate">
                    {p.decision.final_comment}
                  </div>
                )}
              </div>
            </label>
          );
        })}
      </div>

      {materialized.length > 0 && (
        <div className="space-y-1 pt-2 border-t border-amber-200 dark:border-amber-800">
          <div className="text-xs font-semibold text-green-800 dark:text-green-300">
            Учтено в согласованной версии ТЗ ({materialized.length})
          </div>
          <div className="text-xs text-gray-600 dark:text-gray-400">
            Эти решения уже применены к тексту — замечание исчезло из нового
            анализа, потому что исправлено, переносить нечего.
          </div>
          {materialized.map((m) => (
            <div
              key={m.decision.id}
              className="flex items-center gap-2 p-2 rounded border border-green-200 dark:border-green-800 bg-green-50/60 dark:bg-green-900/20"
            >
              <span className="tag bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-300 text-xs">
                {DECISIONS[m.decision.decision] || m.decision.decision}
              </span>
              <span className="text-sm text-gray-800 dark:text-gray-100 truncate">
                {m.decision.cluster_title || formatTzClause(m.decision.tz_clause) || 'замечание прошлого прогона'}
              </span>
            </div>
          ))}
        </div>
      )}

      {proposals.length > 0 && (
        <div className="flex items-center justify-end gap-2 pt-1 border-t border-amber-200 dark:border-amber-800">
          <span className="text-xs text-gray-500 dark:text-gray-400">Выбрано: {selectedCount}</span>
          <button className="btn btn-primary text-xs" disabled={busy || !selectedCount} onClick={confirm}>
            {busy ? 'Переношу…' : 'Подтвердить перенос выбранных'}
          </button>
        </div>
      )}
    </div>
  );
}
