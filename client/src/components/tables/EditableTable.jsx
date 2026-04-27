import { useState } from 'react';

/**
 * Универсальная редактируемая таблица.
 * columns: [{ key, label, type: 'text'|'textarea'|'checkbox'|'select', options?, width? }]
 * rows: массив записей с полем id
 * onUpdate(rowId, patch) — частичное обновление
 * onCreate(data) — добавить новую строку (для пустого row)
 * onDelete(rowId)
 * emptyRowTemplate — шаблон для добавления новой строки
 */
export default function EditableTable({
  columns,
  rows,
  onUpdate,
  onCreate,
  onDelete,
  emptyRowTemplate,
  loading,
  emptyTitle = 'Нет записей',
  addLabel = 'Добавить строку',
}) {
  const [draft, setDraft] = useState(emptyRowTemplate || {});

  const handleAdd = async () => {
    if (!onCreate) return;
    if (!draft || Object.values(draft).every((v) => v === '' || v === false || v == null)) return;
    await onCreate(draft);
    setDraft(emptyRowTemplate || {});
  };

  return (
    <div className="card overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className="table-head" style={c.width ? { width: c.width } : undefined}>{c.label}</th>
            ))}
            {(onDelete || onCreate) && <th className="table-head" />}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr><td className="table-cell text-gray-500" colSpan={columns.length + 1}>Загрузка…</td></tr>
          ) : rows.length === 0 && !onCreate ? (
            <tr><td className="table-cell text-gray-500" colSpan={columns.length + 1}>{emptyTitle}</td></tr>
          ) : null}

          {rows.map((row) => (
            <tr key={row.id} className="border-t border-gray-100">
              {columns.map((c) => (
                <td key={c.key} className="table-cell">
                  <Cell column={c} value={row[c.key]} onChange={(v) => onUpdate && onUpdate(row.id, { [c.key]: v })} />
                </td>
              ))}
              {(onDelete || onCreate) && (
                <td className="table-cell text-right">
                  {onDelete && (
                    <button className="btn btn-ghost text-red-600" onClick={() => { if (confirm('Удалить строку?')) onDelete(row.id); }}>Удалить</button>
                  )}
                </td>
              )}
            </tr>
          ))}

          {onCreate && (
            <tr className="border-t-2 border-gray-200 bg-gray-50">
              {columns.map((c) => (
                <td key={c.key} className="table-cell">
                  <Cell
                    column={c}
                    value={draft[c.key]}
                    onChange={(v) => setDraft((d) => ({ ...d, [c.key]: v }))}
                  />
                </td>
              ))}
              <td className="table-cell text-right">
                <button className="btn btn-primary" onClick={handleAdd}>{addLabel}</button>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function Cell({ column, value, onChange }) {
  const t = column.type || 'text';
  if (t === 'checkbox') {
    return (
      <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4" />
    );
  }
  if (t === 'select') {
    return (
      <select className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {(column.options || []).map((o) => (
          <option key={o.value || o} value={o.value || o}>{o.label || o}</option>
        ))}
      </select>
    );
  }
  if (t === 'textarea') {
    return <textarea className="input min-h-[60px]" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
  }
  return <input className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
}
