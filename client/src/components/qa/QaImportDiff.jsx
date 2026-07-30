import { useState } from 'react';

// Предпросмотр раунда импорта Q&A: diff против текущих активных записей
// (новые / изменённые ответы / без изменений) по каждому листу файла.
// Инженер выбирает листы и применяет раунд — или отменяет его целиком.
// Ничего не применяется без явного подтверждения.

const KIND_META = {
  new: { label: 'новый вопрос', cls: 'bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-300' },
  answer_changed: { label: 'ответ изменился', cls: 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300' },
  unchanged: { label: 'без изменений', cls: 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400' },
};

export default function QaImportDiff({ preview, busy, onApply, onDiscard }) {
  const usable = (preview.sheets || []).filter((s) => s.ok);
  const [chosen, setChosen] = useState(() => new Set(usable.map((s) => s.name)));
  const [showUnchanged, setShowUnchanged] = useState(false);

  const toggleSheet = (name) => setChosen((prev) => {
    const next = new Set(prev);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    return next;
  });

  const willChange = usable
    .filter((s) => chosen.has(s.name))
    .reduce((n, s) => n + s.summary.new + s.summary.answer_changed, 0);

  return (
    <div className="card p-4 space-y-3 border-brand-300 bg-brand-50/40 dark:bg-brand-900/10">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="font-semibold text-sm">
            Предпросмотр импорта — раунд {preview.round_no}
          </div>
          <div className="text-xs text-gray-600 dark:text-gray-400">
            Ничего ещё не применено. Прежние вопросы и ответы не удаляются:
            изменившийся ответ добавится новой записью, старая получит статус
            «заменён». Таблица характеристик импортом не затрагивается.
          </div>
        </div>
        <div className="text-xs text-gray-600 dark:text-gray-400">
          Новых: <strong>{preview.summary.new}</strong> ·
          изменённых: <strong>{preview.summary.answer_changed}</strong> ·
          без изменений: {preview.summary.unchanged}
        </div>
      </div>

      {(preview.sheets || []).map((sheet) => (
        <div key={sheet.name} className="rounded border dark:border-gray-700 bg-white dark:bg-gray-800">
          <div className="flex items-center gap-2 p-2 border-b dark:border-gray-700">
            {sheet.ok ? (
              <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
                <input
                  type="checkbox"
                  checked={chosen.has(sheet.name)}
                  onChange={() => toggleSheet(sheet.name)}
                />
                Лист «{sheet.name}»
              </label>
            ) : (
              <span className="text-sm font-medium text-gray-400 dark:text-gray-500">Лист «{sheet.name}»</span>
            )}
            {sheet.ok ? (
              <span className="text-xs text-gray-500 dark:text-gray-400">
                +{sheet.summary.new} новых, ~{sheet.summary.answer_changed} изменённых, ={sheet.summary.unchanged} без изменений
              </span>
            ) : (
              <span className="text-xs text-amber-700 dark:text-amber-300">пропущен: {sheet.reason}</span>
            )}
          </div>
          {sheet.ok && (
            <div className="max-h-72 overflow-y-auto divide-y dark:divide-gray-700">
              {sheet.items
                .filter((it) => showUnchanged || it.kind !== 'unchanged')
                .map((it, i) => (
                  <div key={i} className="p-2 text-xs space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className={`tag text-[10px] ${KIND_META[it.kind].cls}`}>{KIND_META[it.kind].label}</span>
                      {it.section && <span className="text-gray-400 dark:text-gray-500">{it.section}</span>}
                      {it.round_label && <span className="text-gray-400 dark:text-gray-500">{it.round_label}</span>}
                    </div>
                    <div className="text-gray-800 dark:text-gray-100">{it.question || '—'}</div>
                    {it.kind === 'answer_changed' && (
                      <div className="text-gray-500 dark:text-gray-400 line-through">{it.current_answer || '—'}</div>
                    )}
                    <div className="text-gray-700 dark:text-gray-300">{it.answer || '—'}</div>
                  </div>
                ))}
              {!showUnchanged && sheet.summary.unchanged > 0 && (
                <button
                  type="button"
                  className="w-full p-2 text-xs text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700"
                  onClick={() => setShowUnchanged(true)}
                >
                  Показать {sheet.summary.unchanged} строк без изменений
                </button>
              )}
            </div>
          )}
        </div>
      ))}

      <div className="flex items-center justify-end gap-2 pt-1 border-t dark:border-gray-700">
        <button type="button" className="btn text-xs" disabled={busy} onClick={onDiscard}>
          Отменить раунд
        </button>
        <button
          type="button"
          className="btn btn-primary text-xs"
          disabled={busy || !chosen.size}
          title={willChange ? '' : 'Изменений нет — применение только зафиксирует раунд'}
          onClick={() => onApply([...chosen])}
        >
          {busy ? 'Применяю…' : `Применить (${willChange} изменений)`}
        </button>
      </div>
    </div>
  );
}
