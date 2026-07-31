import { useEffect, useState } from 'react';
import { api } from '../../services/api';
import { toastError, toastSuccess } from '../../store/useToastStore';

// Матрица покрытия существенных условий (итог Стадии 3): статус каждой темы
// (соответствует / противоречит / отсутствует / неоднозначно / в другом
// документе / проверка договора / неприменимо / урегулировано в договоре /
// риск принят) + действие для отсутствующих. Инженер дополняет знание пакета
// через override; тему закрывает только ЗАКРЫВАЮЩИЙ статус (флаг closed от
// сервера) — примечание или «проверка договора» находку не снимают.

const STATUS_BADGE = {
  matches: 'bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300',
  contradicts: 'bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300',
  missing: 'bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300',
  ambiguous: 'bg-orange-100 text-orange-800 dark:bg-orange-900/50 dark:text-orange-300',
  other_document: 'bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-300',
  check_contract: 'bg-violet-100 text-violet-800 dark:bg-violet-900/50 dark:text-violet-300',
  not_applicable: 'bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-400',
  resolved_in_contract: 'bg-teal-100 text-teal-800 dark:bg-teal-900/50 dark:text-teal-300',
  risk_accepted: 'bg-lime-100 text-lime-800 dark:bg-lime-900/50 dark:text-lime-300',
};

export default function CoveragePanel({ tenderId }) {
  const [data, setData] = useState(null);
  const [busyKey, setBusyKey] = useState(null);

  const load = async () => {
    if (!tenderId) return;
    try {
      setData(await api.getConditionsCoverage(tenderId));
    } catch (err) { toastError(err.message); }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [tenderId]);

  if (!data) return null;
  if (!data.run_id || !data.items?.length) {
    return (
      <div className="card p-4">
        <h3 className="font-semibold">Покрытие существенных условий</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Матрица появится после прогона Стадии 3 (анализ существенных условий):
          по каждому условию и теме — соответствует / противоречит / отсутствует /
          неоднозначно, для отсутствующих — правильное действие.
        </p>
      </div>
    );
  }

  const statuses = data.dictionaries?.statuses || [];
  const resolutions = data.dictionaries?.resolutions || [];
  // Разбиение по флагу сервера: открытые статусы (missing / contradicts /
  // ambiguous / check_contract) требуют внимания, закрытые темы — свёрнуты.
  const problems = data.items.filter((it) => !it.closed);
  const rest = data.items.filter((it) => it.closed);

  const applyOverride = async (item, patch) => {
    setBusyKey(item.topic_key);
    try {
      const res = await api.setCoverageOverride(tenderId, item.topic_key, patch);
      setData((d) => ({ ...d, items: res.items, summary: res.summary }));
      toastSuccess('Покрытие обновлено');
    } catch (err) { toastError(err.message); }
    setBusyKey(null);
  };

  return (
    <div className="card p-4 space-y-3">
      <div>
        <h3 className="font-semibold">Покрытие существенных условий</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
          Итог Стадии 3 по всем частям ТЗ. Отсутствующее условие — не правка текста,
          а действие: запрос Заказчику, допущение, условие КП, проверка договора, резерв риска.
          Тему закрывают только статусы «соответствует» / «в другом документе» / «неприменимо» /
          «урегулировано в договоре» / «риск принят»; «проверка договора» и примечание
          находку не снимают — вопрос остаётся открытым.
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5 text-[11px]">
        {Object.entries(data.summary || {}).map(([st, n]) => (
          <span key={st} className={`px-1.5 py-0.5 rounded-full ${STATUS_BADGE[st] || ''}`}>
            {(statuses.find((s) => s.value === st)?.label) || st}: {n}
          </span>
        ))}
      </div>

      <CoverageSection
        title="Требуют внимания"
        items={problems}
        statuses={statuses}
        resolutions={resolutions}
        busyKey={busyKey}
        onOverride={applyOverride}
        emptyText="Противоречий, пробелов и неоднозначностей не найдено."
      />
      <CoverageSection
        title="Закрытые темы"
        items={rest}
        statuses={statuses}
        resolutions={resolutions}
        busyKey={busyKey}
        onOverride={applyOverride}
        collapsed
      />
    </div>
  );
}

function CoverageSection({ title, items, statuses, resolutions, busyKey, onOverride, collapsed = false, emptyText = null }) {
  const [open, setOpen] = useState(!collapsed);
  return (
    <div>
      <button
        type="button"
        className="text-xs font-semibold text-gray-600 dark:text-gray-300 uppercase tracking-wide"
        onClick={() => setOpen((v) => !v)}
      >
        {title} ({items.length}) {open ? '▾' : '▸'}
      </button>
      {open && (
        <div className="mt-1.5 space-y-1.5">
          {items.length === 0 && emptyText && (
            <div className="text-xs text-gray-500 dark:text-gray-400 italic">{emptyText}</div>
          )}
          {items.map((it) => (
            <CoverageRow
              key={it.topic_key}
              item={it}
              statuses={statuses}
              resolutions={resolutions}
              busy={busyKey === it.topic_key}
              onOverride={onOverride}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CoverageRow({ item, statuses, resolutions, busy, onOverride }) {
  const [edit, setEdit] = useState(false);
  const [status, setStatus] = useState(item.override?.status || '');
  const [resolution, setResolution] = useState(item.override?.resolution || item.resolution || '');
  const [note, setNote] = useState(item.override?.note || '');

  const evidence = (item.evidence || []).filter((e) => e.fragment);

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-2.5 py-1.5">
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium">{item.topic_name}</div>
          <div className="text-[11px] text-gray-500 dark:text-gray-400">
            {item.kind === 'condition' ? 'условие компании' : 'тема покрытия'}
            {item.resolution_label && <span className="ml-1.5">· действие: {item.resolution_label}</span>}
            {item.override && <span className="ml-1.5">· отмечено инженером</span>}
          </div>
        </div>
        <span className={`text-[11px] px-1.5 py-0.5 rounded-full whitespace-nowrap ${STATUS_BADGE[item.status] || ''}`}>
          {item.status_label}
        </span>
        <button
          type="button"
          className="btn btn-secondary text-xs"
          onClick={() => setEdit((v) => !v)}
          disabled={busy}
        >
          {edit ? 'Свернуть' : 'Уточнить'}
        </button>
      </div>

      {evidence.length > 0 && !edit && (
        <div className="mt-1 text-[11px] text-gray-500 dark:text-gray-400 truncate" title={evidence[0].fragment}>
          «{evidence[0].fragment}»
        </div>
      )}

      {item.override?.note && !edit && (
        <div className="mt-1 text-[11px] text-gray-600 dark:text-gray-300">
          Комментарий инженера: {item.override.note}
        </div>
      )}

      {edit && (
        <div className="mt-2 grid grid-cols-1 md:grid-cols-3 gap-2 text-xs border-t border-gray-100 dark:border-gray-700 pt-2">
          <label className="flex flex-col gap-0.5">
            <span className="text-gray-500 dark:text-gray-400">Статус (инженер)</span>
            <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">— как определил анализ —</option>
              {statuses.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-gray-500 dark:text-gray-400">Действие</span>
            <select className="input" value={resolution} onChange={(e) => setResolution(e.target.value)}>
              <option value="">—</option>
              {resolutions.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-0.5 md:col-span-3">
            <span className="text-gray-500 dark:text-gray-400">
              Комментарий (не закрывает тему — риск остаётся в реестре)
            </span>
            <textarea
              className="input"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Например: лимит есть в проекте договора, п. 12.4 — включить вопрос в первый раунд Q&A"
            />
          </label>
          <div className="flex items-end justify-end gap-1.5 md:col-span-3">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={async () => {
                await onOverride(item, {
                  status: status || null,
                  resolution: resolution || null,
                  note: note.trim() || null,
                });
                setEdit(false);
              }}
            >
              {busy ? 'Сохранение…' : 'Сохранить'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
