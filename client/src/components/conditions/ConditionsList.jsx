import { useState } from 'react';
import clsx from 'clsx';

export default function ConditionsList({ items, locked, onPatch, onResetOverride }) {
  if (!items || !items.length) {
    return <div className="text-gray-500 text-sm">Нет условий.</div>;
  }
  return (
    <div className="card overflow-hidden">
      <table className="w-full table-fixed">
        <thead>
          <tr>
            <th className="table-head w-12">№</th>
            <th className="table-head w-1/3">Наименование</th>
            <th className="table-head">Текст условия</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => (
            <ConditionRow
              key={it.idx}
              item={it}
              locked={locked}
              onPatch={onPatch}
              onResetOverride={onResetOverride}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ConditionRow({ item, locked, onPatch, onResetOverride }) {
  const [editingText, setEditingText] = useState(false);
  const [draft, setDraft] = useState(item.text);

  const beginEdit = () => {
    setDraft(item.text || '');
    setEditingText(true);
  };

  const saveEdit = async () => {
    await onPatch(item.idx, { text_override: draft });
    setEditingText(false);
  };

  const cancelEdit = () => {
    setDraft(item.text || '');
    setEditingText(false);
  };

  const resetOverride = async () => {
    if (!confirm('Вернуть текст пункта к шаблонному (отменить ваши правки)?')) return;
    await onResetOverride(item.idx);
  };

  return (
    <tr className="border-t border-gray-100 align-top">
      <td className="table-cell text-center text-gray-500 font-mono">{item.idx}</td>
      <td className="table-cell">
        <div className="font-medium text-sm break-words">{item.name}</div>
        <div className="mt-1 flex flex-wrap gap-1">
          {item.isOverridden && (
            <span className="tag bg-blue-100 text-blue-800 text-[10px]" title="Текст изменён вручную">
              ✎ override
            </span>
          )}
        </div>
      </td>
      <td className="table-cell">
        {editingText ? (
          <div className="space-y-2">
            <textarea
              className="input min-h-[140px] font-mono text-xs leading-snug"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              disabled={locked}
            />
            <div className="flex gap-2 justify-end">
              <button className="btn btn-secondary text-xs" onClick={cancelEdit} disabled={locked}>
                Отмена
              </button>
              <button className="btn btn-primary text-xs" onClick={saveEdit} disabled={locked}>
                Сохранить override
              </button>
            </div>
          </div>
        ) : (
          <div>
            <div
              className={clsx(
                'text-sm whitespace-pre-wrap break-words',
                !item.text && 'text-gray-400 italic',
                item.isOverridden && 'border-l-2 border-blue-400 pl-2'
              )}
            >
              {item.text || '— пусто —'}
            </div>
            {!locked && (
              <div className="mt-2 flex gap-2 flex-wrap">
                <button className="btn btn-ghost text-xs text-blue-700" onClick={beginEdit}>
                  ✎ Редактировать текст
                </button>
                {item.isOverridden && (
                  <button className="btn btn-ghost text-xs text-amber-700" onClick={resetOverride}>
                    ↺ К шаблону
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}
