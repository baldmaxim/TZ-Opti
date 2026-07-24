import { useThemeStore } from '../../store/useThemeStore';

// Переключатель темы: солнце + тумблер + луна. Тумблер зелёный во включённом
// (тёмном) состоянии; активная иконка подсвечивается, неактивная приглушена.
export default function ThemeToggle() {
  const theme = useThemeStore((s) => s.theme);
  const toggle = useThemeStore((s) => s.toggle);
  const isDark = theme === 'dark';

  return (
    <div className="flex items-center gap-2">
      {/* солнце */}
      <svg
        width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
        className={isDark ? 'text-gray-500' : 'text-amber-500'}
      >
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
      </svg>

      {/* тумблер */}
      <button
        type="button"
        role="switch"
        aria-checked={isDark}
        onClick={toggle}
        title={isDark ? 'Светлая тема' : 'Тёмная тема'}
        aria-label={isDark ? 'Включить светлую тему' : 'Включить тёмную тему'}
        className={`relative inline-flex h-5 w-10 items-center rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 ${
          isDark ? 'bg-emerald-500' : 'bg-gray-300'
        }`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200 ${
            isDark ? 'translate-x-5' : 'translate-x-0.5'
          }`}
        />
      </button>

      {/* луна */}
      <svg
        width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
        className={isDark ? 'text-emerald-400' : 'text-gray-400'}
      >
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>
    </div>
  );
}
