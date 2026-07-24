import clsx from 'clsx';
import { useToastStore } from '../../store/useToastStore';

export default function Toasts() {
  const toasts = useToastStore((s) => s.toasts);
  const remove = useToastStore((s) => s.remove);
  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {toasts.map((t) => (
        <div
          key={t.id}
          onClick={() => remove(t.id)}
          className={clsx(
            'cursor-pointer rounded-md shadow-lg px-4 py-3 text-sm border dark:border-gray-700',
            t.type === 'success' && 'bg-green-50 dark:bg-green-900/40 border-green-200 dark:border-green-800 text-green-900 dark:text-green-200',
            t.type === 'warning' && 'bg-amber-50 dark:bg-amber-900/40 border-amber-200 dark:border-amber-800 text-amber-900 dark:text-amber-200',
            t.type === 'error' && 'bg-red-50 dark:bg-red-900/40 border-red-200 dark:border-red-800 text-red-900 dark:text-red-200',
            t.type === 'info' && 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-900 dark:text-gray-100'
          )}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
