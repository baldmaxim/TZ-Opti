import { useEffect, useState } from 'react';
import { api } from '../../services/api';
import { toastError, toastSuccess } from '../../store/useToastStore';
import { useTenderStore } from '../../store/useTenderStore';

// Карта сопоставления «требование ТЗ ↔ позиции ВОР» (итог Стадии 1).
// Каждая связь: требование → позиции ведомости (количество и единица — ФАКТ
// ведомости) → включённые/недостающие операции → исключения → примечания по
// единицам и количеству → уверенность → решение инженера. Лексическая связь без
// подтверждения не считается доказательством количественного покрытия.

const STATUS_BADGE = {
  covered: 'bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300',
  partial: 'bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300',
  not_covered: 'bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300',
  unclear: 'bg-orange-100 text-orange-800 dark:bg-orange-900/50 dark:text-orange-300',
};

const CONFIRM_OPTIONS = [
  { value: 'confirmed', label: 'Подтвердить связь' },
  { value: 'rejected', label: 'Отклонить связь' },
  { value: 'adjusted', label: 'Скорректировано' },
];

export default function VorMatchingPage() {
  const tenderId = useTenderStore((s) => s.tenderId);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState(null);

  const load = async () => {
    if (!tenderId) return;
    setLoading(true);
    try {
      setData(await api.getVorRequirements(tenderId));
    } catch (err) { toastError(err.message); }
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [tenderId]);

  const confirm = async (item, patch) => {
    setBusyKey(item.match_key);
    try {
      const res = await api.confirmVorRequirement(tenderId, item.match_key, patch);
      setData((d) => ({ ...d, items: res.items, summary: res.summary }));
      toastSuccess('Решение по связи сохранено');
    } catch (err) { toastError(err.message); }
    setBusyKey(null);
  };

  if (loading && !data) return <div className="text-center text-gray-500 dark:text-gray-400 py-8">Загрузка…</div>;
  if (!data || !data.run_id || !data.items?.length) {
    return (
      <div className="space-y-3">
        <h2 className="text-lg font-semibold">Покрытие ВОР</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Карта сопоставления появится после прогона Стадии 1: каждое требование ТЗ будет
          связано с позициями ведомости (операции, единицы, количества) и получит статус
          покрытия для подтверждения инженером.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Покрытие ВОР: требования ТЗ ↔ позиции ведомости</h2>
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-0.5">
          Количества и единицы берутся из ведомости, а не со слов модели. Совпадение по словам —
          не доказательство покрытия: проверьте состав операций и подтвердите или отклоните связь.
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5 text-[11px]">
        {['not_covered', 'partial', 'unclear', 'covered'].map((st) => (
          data.summary?.[st] ? (
            <span key={st} className={`px-1.5 py-0.5 rounded-full ${STATUS_BADGE[st]}`}>
              {st === 'covered' ? 'Покрыто' : st === 'partial' ? 'Частично' : st === 'not_covered' ? 'Не покрыто' : 'Неясно'}: {data.summary[st]}
            </span>
          ) : null
        ))}
        <span className="px-1.5 py-0.5 rounded-full bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300">
          Подтверждено: {data.summary?.confirmed || 0} из {data.items.length}
        </span>
      </div>

      <div className="space-y-2">
        {data.items.map((it) => (
          <MatchCard key={it.match_key} item={it} busy={busyKey === it.match_key} onConfirm={confirm} />
        ))}
      </div>
    </div>
  );
}

function MatchCard({ item, busy, onConfirm }) {
  const [note, setNote] = useState(item.confirmation?.note || '');
  const conf = item.confirmation;

  return (
    <div className="card p-3 space-y-2">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium">«{item.requirement_fragment}»</div>
          <div className="text-[11px] text-gray-500 dark:text-gray-400">
            {item.section_path || '—'}
            {item.confidence != null && <span className="ml-1.5">· уверенность {Math.round(item.confidence * 100)}%</span>}
          </div>
        </div>
        <span className={`text-[11px] px-1.5 py-0.5 rounded-full whitespace-nowrap ${STATUS_BADGE[item.coverage_status] || ''}`}>
          {item.coverage_label}
        </span>
      </div>

      {item.positions.length > 0 && (
        <div className="overflow-x-auto">
          <table className="text-xs w-full">
            <thead>
              <tr className="text-left text-gray-500 dark:text-gray-400">
                <th className="pr-3 py-0.5">№</th>
                <th className="pr-3 py-0.5">Позиция ВОР</th>
                <th className="pr-3 py-0.5">Документ</th>
                <th className="pr-3 py-0.5">Кол-во</th>
                <th className="pr-3 py-0.5">Ед.</th>
                <th className="py-0.5">Сверка с ведомостью</th>
              </tr>
            </thead>
            <tbody>
              {item.positions.map((p, i) => (
                <tr key={i} className="border-t border-gray-100 dark:border-gray-700">
                  <td className="pr-3 py-0.5">{p.position_no || '—'}</td>
                  <td className="pr-3 py-0.5">{p.name || '—'}</td>
                  <td className="pr-3 py-0.5">
                    {p.document_name || '—'}
                    {p.applicability && <span className="text-gray-500 dark:text-gray-400 ml-1">({p.applicability})</span>}
                  </td>
                  <td className="pr-3 py-0.5">{p.quantity ?? '—'}</td>
                  <td className="pr-3 py-0.5">
                    {p.unit || '—'}
                    {p.unit_mismatch && <span className="text-red-600 dark:text-red-400 ml-1">≠ {p.claimed_unit}</span>}
                  </td>
                  <td className="py-0.5">
                    {p.verified
                      ? <span className="text-green-700 dark:text-green-300">позиция найдена в ведомости</span>
                      : p.ambiguous
                        ? <span className="text-amber-700 dark:text-amber-300">номер есть в нескольких ВОР — документ не определён</span>
                        : <span className="text-red-700 dark:text-red-300">в ведомости не найдена</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
        {item.operations_included.length > 0 && (
          <div>
            <span className="text-gray-500 dark:text-gray-400">Входит в позиции: </span>
            {item.operations_included.join('; ')}
          </div>
        )}
        {item.operations_missing.length > 0 && (
          <div className="text-amber-800 dark:text-amber-300">
            <span className="font-medium">Не входит: </span>
            {item.operations_missing.join('; ')}
          </div>
        )}
        {item.exclusions.length > 0 && (
          <div>
            <span className="text-gray-500 dark:text-gray-400">Исключено: </span>
            {item.exclusions.join('; ')}
          </div>
        )}
        {item.unit_note && (
          <div>
            <span className="text-gray-500 dark:text-gray-400">Единицы: </span>
            {item.unit_note}
          </div>
        )}
        {item.quantity_note && (
          <div>
            <span className="text-gray-500 dark:text-gray-400">Количество: </span>
            {item.quantity_note}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-t border-gray-100 dark:border-gray-700 pt-2">
        {conf ? (
          <span className="text-xs text-gray-600 dark:text-gray-300">
            {conf.label}{conf.note ? ` — ${conf.note}` : ''}
          </span>
        ) : (
          <span className="text-xs text-gray-400 dark:text-gray-500 italic">Связь не подтверждена инженером</span>
        )}
        <div className="flex-1" />
        <input
          className="input text-xs w-56"
          placeholder="Заметка (необязательно)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={busy}
        />
        {CONFIRM_OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            className={`btn text-xs ${conf?.status === o.value ? 'btn-primary' : 'btn-secondary'}`}
            disabled={busy}
            onClick={() => onConfirm(item, { status: o.value, note: note || null })}
          >
            {o.label}
          </button>
        ))}
        {conf && (
          <button
            type="button"
            className="btn btn-ghost text-xs text-gray-500"
            disabled={busy}
            onClick={() => onConfirm(item, { status: null, note: null })}
          >
            Снять
          </button>
        )}
      </div>
    </div>
  );
}
