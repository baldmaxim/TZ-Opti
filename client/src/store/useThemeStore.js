import { create } from 'zustand';

// Тема портала (светлая/тёмная). Источник правды — этот стор + localStorage.
// Класс `dark` на <html> включает Tailwind dark:-варианты. Первичная установка
// класса — инлайн-скрипт в index.html (без FOUC); здесь держим состояние в
// синхроне и переключаем по действию пользователя.

const STORAGE_KEY = 'theme';

// Первая тема: сохранённый выбор, иначе системная prefers-color-scheme.
// Зеркало инлайн-скрипта в index.html.
export function getInitialTheme() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch (_e) {
    return 'light';
  }
}

// Применяет тему к <html> и запоминает выбор.
function applyTheme(theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch (_e) {
    // localStorage недоступен (приватный режим) — тема живёт только в памяти.
  }
}

export const useThemeStore = create((set, get) => ({
  theme: getInitialTheme(),
  setTheme(theme) {
    applyTheme(theme);
    set({ theme });
  },
  toggle() {
    const next = get().theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    set({ theme: next });
  },
}));

export const toggleTheme = () => useThemeStore.getState().toggle();
