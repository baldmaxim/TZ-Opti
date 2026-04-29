import clsx from 'clsx';

/**
 * Блок «Основные параметры тендера».
 * schema: [{ key, kind, label, options?, default }]
 * params: текущие значения (escalation/advance/build_months/transfer_months/kp_date)
 */
export default function ParamsPanel({ schema, params, onChange, disabled, footerAction }) {
  if (!schema || !params) return null;

  const set = (key, value) => onChange({ ...params, [key]: value });

  return (
    <div className="card p-4">
      <h3 className="font-semibold mb-3">Основные параметры тендера</h3>
      {disabled ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-x-6 gap-y-2">
          {schema.map((field) => (
            <div key={field.key} className="min-w-0">
              <div className="text-[11px] uppercase tracking-wide text-gray-500 truncate">
                {field.label}
              </div>
              <div className="text-base font-semibold text-gray-900 mt-0.5 truncate">
                {formatValue(field, params[field.key])}
              </div>
            </div>
          ))}
        </div>
      ) : (
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
      )}
      {footerAction && (
        <div className={clsx('flex justify-end', disabled ? 'mt-2' : 'mt-3')}>
          {footerAction}
        </div>
      )}
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

function formatValue(field, value) {
  if (value === null || value === undefined || value === '') return '—';
  if (field.kind === 'date') {
    const d = new Date(String(value).slice(0, 10));
    return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleDateString('ru-RU');
  }
  return String(value);
}
