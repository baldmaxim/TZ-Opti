// Хранение access-токена на клиенте.
//
// Портал не занимается входом сам: токен выдаёт корпоративный провайдер
// (OIDC), а сюда попадает уже готовый Bearer. Поэтому здесь только три вещи —
// где токен лежит, как его подставить в запрос и что делать, когда сервер
// ответил 401.
//
// Токен держим в sessionStorage, а не в localStorage: он живёт до закрытия
// вкладки и не остаётся на общем рабочем компьютере после ухода инженера.

const STORAGE_KEY = 'tz_opti.access_token';

// Токен для локальной разработки: удобно подложить через .env клиента,
// не трогая код. В production переменной просто нет.
const DEV_TOKEN = import.meta.env?.VITE_AUTH_TOKEN || '';

let memoryToken = '';

export function getToken() {
  if (memoryToken) return memoryToken;
  try {
    return sessionStorage.getItem(STORAGE_KEY) || DEV_TOKEN;
  } catch (_e) {
    return DEV_TOKEN; // sessionStorage недоступен (жёсткие настройки браузера)
  }
}

export function setToken(token) {
  memoryToken = token || '';
  try {
    if (token) sessionStorage.setItem(STORAGE_KEY, token);
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch (_e) {
    /* остаётся только память процесса вкладки */
  }
}

export function clearToken() {
  setToken('');
}

export function authHeaders() {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// Слушатели «сервер больше не принимает наш токен» — на них подписывается UI,
// чтобы показать «нужно войти заново», а не молча ломаться.
const listeners = new Set();

export function onUnauthorized(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notifyUnauthorized(reason) {
  clearToken();
  for (const fn of listeners) {
    try {
      fn(reason);
    } catch (_e) {
      /* один сломавшийся слушатель не мешает остальным */
    }
  }
}
