import { Link, useLocation } from 'react-router-dom';
import Toasts from '../ui/Toasts';

export default function Layout({ children }) {
  const loc = useLocation();
  return (
    <div className="min-h-full">
      <header className="bg-white border-b border-gray-200 sticky top-0 z-30">
        <div className="max-w-[1400px] mx-auto px-4 py-3 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2">
            <div className="w-8 h-8 rounded bg-brand-600 text-white flex items-center justify-center font-bold">TZ</div>
            <div>
              <div className="font-semibold leading-none">TZ-Opti</div>
              <div className="text-xs text-gray-500">Анализ ТЗ на СМР</div>
            </div>
          </Link>
          <nav className="flex items-center gap-4 text-sm">
            <Link to="/" className={loc.pathname === '/' ? 'text-brand-700 font-semibold' : 'text-gray-700 hover:text-brand-600'}>Тендеры</Link>
            <a href="https://github.com" className="text-gray-400 hover:text-gray-600 text-xs">v0.1 MVP</a>
          </nav>
        </div>
      </header>
      <main className="max-w-[1400px] mx-auto px-4 py-6">
        {children}
      </main>
      <Toasts />
    </div>
  );
}
