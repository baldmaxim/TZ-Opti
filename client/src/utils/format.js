export const formatDate = (iso) => {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch (_e) { return iso; }
};

export const formatDateTime = (iso) => {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch (_e) { return iso; }
};

export const truncate = (s, n = 80) => {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

// Чистит «хлебный путь» места в ТЗ (tz_clause) от шума: имени файла, служебных
// блоков парсера (BLOCK [TEXT]: <id>) и внутренних id. Оставляет осмысленный хвост
// (напр. «СТРАНИЦА 2 › Оглавление»). Если ничего не осталось — последний сегмент.
const FILE_EXT_RE = /\.(pdf|docx?|md|xlsx?|csv)\b/i;
const BLOCK_RE = /^block\b|\[(?:text|table|image|list)\]/i;
export const formatTzClause = (raw) => {
  if (!raw) return '';
  const parts = String(raw)
    .split('›')
    .map((s) => s.trim())
    .filter(Boolean);
  const kept = parts.filter((seg) => !FILE_EXT_RE.test(seg) && !BLOCK_RE.test(seg));
  const out = (kept.length ? kept : parts.slice(-1)).join(' › ').trim();
  return out;
};

// Превращает внутренние служебные токены анализатора в человеческий русский —
// их не должно быть в тексте для инженера. LLM-агент стадии 1 иногда тащит в
// замечание/рекомендацию имя колонки чек-листа in_calc (1 — ГП выполняет,
// 0 — не выполняет, null — статус не определён). Чистим на показе, чтобы это
// не зависело от пересборки анализа.
// Разделитель опционален: ловит и «in_calc=0», и «in_calc 0», и
// «in_calc не определён» (агент пишет имя поля и без знака равенства).
const IN_CALC_RE = /\bin[_\s]?calc\s*[=:]?\s*(1|0|null|не\s*определ[её]н\w*)/gi;
export const humanizeNote = (text) => {
  if (!text) return text;
  return String(text).replace(IN_CALC_RE, (_m, val) => {
    const v = String(val).toLowerCase();
    if (v === '1') return 'входит в объём ГП';
    if (v === '0') return 'не входит в объём ГП';
    return 'статус не определён';
  });
};

// Тема кластера без хвоста-пути: cluster_title = "<тема> — <tz_clause>". Отрезаем
// длинный tz_clause, оставляя короткую тему (напр. «Влияние на стоимость»).
export const clusterTopic = (cluster) => {
  const title = (cluster && cluster.cluster_title) || '';
  const clause = (cluster && cluster.tz_clause) || '';
  if (clause && title.endsWith(clause)) {
    return title.slice(0, title.length - clause.length).replace(/\s*[—-]\s*$/, '').trim() || title;
  }
  const i = title.indexOf(' — ');
  return i > 0 ? title.slice(0, i).trim() : title;
};
