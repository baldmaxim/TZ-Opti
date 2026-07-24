import { useEffect } from 'react';

export default function Modal({ open, onClose, title, children, footer, size = 'md' }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose && onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  const widths = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl', xl: 'max-w-5xl' };
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/40 p-4 overflow-y-auto">
      <div className={`relative bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full ${widths[size] || widths.md} my-8`}>
        <div className="flex items-center justify-between px-5 py-3 border-b dark:border-gray-700">
          <h3 className="font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
          <button className="text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 text-xl leading-none" onClick={onClose}>×</button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer ? <div className="px-5 py-3 border-t dark:border-gray-700 bg-gray-50 dark:bg-gray-800 rounded-b-lg flex justify-end gap-2">{footer}</div> : null}
      </div>
    </div>
  );
}
