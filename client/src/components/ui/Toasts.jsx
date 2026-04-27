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
            'cursor-pointer rounded-md shadow-lg px-4 py-3 text-sm border',
            t.type === 'success' && 'bg-green-50 border-green-200 text-green-900',
            t.type === 'error' && 'bg-red-50 border-red-200 text-red-900',
            t.type === 'info' && 'bg-white border-gray-200 text-gray-900'
          )}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
