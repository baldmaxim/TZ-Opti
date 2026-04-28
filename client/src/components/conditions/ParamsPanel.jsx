import clsx from 'clsx';

/**
 * Блок «Основные параметры тендера».
 * schema: [{ key, kind, label, options?, default }]
 * params: текущие значения (escalation/advance/build_months/transfer_months/kp_date)
 */
export default function ParamsPanel({ schema, params, onChange, disabled }) {
  if (!schema || !params) return null;

  const set = (key, value) => onChange({ ...params, [key]: value });

  return (
    <div className={clsx('card p-4', disabled && 'opacity-95')}>
      <h3 className="font-semibold mb-3">Основные параметры тендера</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {schema.map((field) => (
          <div key={field.key}>
            <label className="label">{field.label}</label>
            <ParamInput
              field={field}
              value={params[field.key]}
              onChange={(v) => set(field.key, v)}
              disabled={disabled}
            />
          </div>
        ))}
      </div>
      <p className="text-xs text-gray-500 mt-3">
        Изменение параметров автоматически пересчитывает динамические условия ниже.
      </p>
    </div>
  );
}

function ParamInput({ field, value, onChange, disabled }) {
  if (field.kind === 'enum') {
    return (
      <select
        className="input"
        value={value || ''}
        onChange={(e) => onChange(e.target.value || null)}
        disabled={disabled}
      >
        <option value="">— не выбрано —</option>
        {field.options.map((opt) => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
    );
  }
  if (field.kind === 'int') {
    return (
      <input
        type="number"
        min="0"
        className="input"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        disabled={disabled}
      />
    );
  }
  if (field.kind === 'date') {
    const dateValue = value ? String(value).slice(0, 10) : '';
    return (
      <input
        type="date"
        className="input"
        value={dateValue}
        onChange={(e) => onChange(e.target.value || null)}
        disabled={disabled}
      />
    );
  }
  return (
    <input
      type="text"
      className="input"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
    />
  );
}
