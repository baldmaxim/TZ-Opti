import clsx from 'clsx';

const STYLES = {
  finished: 'bg-green-600 text-white border-green-600',
  current: 'bg-brand-600 text-white border-brand-600 ring-2 ring-brand-200',
  available: 'bg-white text-gray-500 border-gray-300',
  locked: 'bg-gray-100 text-gray-400 border-gray-200',
};

const ICONS = {
  finished: '✓',
  current: '●',
  available: '○',
  locked: '🔒',
};

export default function StepStatus({ status, label, size = 'sm' }) {
  const dim = size === 'sm' ? 'w-5 h-5 text-[11px]' : 'w-6 h-6 text-xs';
  return (
    <span
      className={clsx(
        'flex items-center justify-center rounded-full border font-semibold flex-shrink-0',
        dim,
        STYLES[status] || STYLES.available
      )}
      aria-label={label}
      title={label}
    >
      {ICONS[status] || ICONS.available}
    </span>
  );
}
