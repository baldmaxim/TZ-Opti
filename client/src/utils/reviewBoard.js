// Чистая логика страницы инженерной проверки замечаний ИИ (ReviewPage).
//
// Здесь НЕТ React и обращений к сети — только данные: вкладки, фильтры,
// статистика, валидация решений, маппинг действий инженера в payload'ы двух
// слоёв (production review_decisions и shadow-слой qualification gate),
// горячие клавиши, поиск цитаты в тексте ТЗ и сохранение состояния просмотра.
// Тестируется офлайн из node:test (server/test/unit/reviewBoardClient.test.js).
//
// ГЛАВНЫЙ ИНВАРИАНТ (shadow mode): квалификация gate — только РЕКОМЕНДАЦИЯ.
// Распределение по вкладкам и production-статус замечания считаются ТОЛЬКО из
// production-полей кластера (verdict / impact / решение инженера); действия
// «На проверку», «Объединить» и «Изменить приоритет» пишутся ТОЛЬКО в
// shadow-слой (productionPayloadFor возвращает null).

// --- Вкладки -----------------------------------------------------------------

export const REVIEW_TABS = [
  { key: 'critical', label: 'Критичные' },
  { key: 'working', label: 'Рабочие' },
  { key: 'review', label: 'На проверку' },
  { key: 'low', label: 'Низкий приоритет' },
  { key: 'hidden', label: 'Скрытые фильтром' },
  { key: 'all', label: 'Все' },
];

export const TAB_KEYS = REVIEW_TABS.map((t) => t.key);

const HIGH_IMPACT = ['critical', 'high'];
const LOW_IMPACT = ['low', 'none'];

// Вкладка кластера — ТОЛЬКО из production-модели материальности
// (verdict + impact; легаси-прогоны без вердикта — по criticality).
// Квалификация gate сюда НЕ входит: gate работает в shadow mode.
export function tabOf(cluster = {}) {
  const verdict = cluster.verdict || null;
  const impact = cluster.overall_impact_level || null;
  const legacy = cluster.overall_criticality || null;
  if (verdict === 'verify') return 'review';
  if (verdict === 'publish') {
    const level = impact || legacy;
    return HIGH_IMPACT.includes(level) ? 'critical' : 'working';
  }
  if (verdict === 'suppress') {
    const level = impact || legacy;
    return LOW_IMPACT.includes(level) ? 'low' : 'hidden';
  }
  // Легаси без вердикта: критичность — единственный ориентир.
  if (HIGH_IMPACT.includes(legacy)) return 'critical';
  if (legacy === 'medium') return 'working';
  if (legacy === 'low') return 'low';
  return 'review';
}

export function filterByTab(clusters = [], tab = 'all') {
  if (tab === 'all') return clusters.slice();
  return clusters.filter((c) => tabOf(c) === tab);
}

export function tabCounts(clusters = []) {
  const counts = Object.fromEntries(TAB_KEYS.map((k) => [k, 0]));
  counts.all = clusters.length;
  for (const c of clusters) counts[tabOf(c)] += 1;
  return counts;
}

// --- Режим «Только существенные» --------------------------------------------
// Показывает critical, high (вкладка critical) и «На проверку» (review).
// Ничего не удаляет — это фильтр видимости, снимается одним действием.

export const ESSENTIAL_TABS = ['critical', 'review'];

export const isEssential = (c) => ESSENTIAL_TABS.includes(tabOf(c));

// Итоговый видимый список: essential-фильтр поверх вкладки. Исходный массив
// не мутируется.
export function visibleClusters(clusters = [], { tab = 'all', essential = false } = {}) {
  const base = essential ? clusters.filter(isEssential) : clusters;
  return filterByTab(base, tab);
}

// --- Статус решения и статистика --------------------------------------------

const PROD_ACCEPTING = ['accept', 'edit', 'delete', 'remove_from_scope'];

// Единый статус обработки замечания: production-решение (если есть) главнее
// shadow-решения. null — не обработано.
export function decisionStateOf(cluster = {}, shadowDecision = null) {
  const prod = cluster.decision && cluster.decision.decision;
  if (prod === 'reject') return 'rejected';
  if (PROD_ACCEPTING.includes(prod)) return 'accepted';
  const s = shadowDecision && shadowDecision.decision;
  if (s === 'accepted' || s === 'accepted_with_edit') return 'accepted';
  if (s === 'rejected') return 'rejected';
  if (s === 'deferred') return 'deferred';
  if (s === 'merged') return 'merged';
  return null;
}

export const GATE_HIDING = ['hide', 'reject'];

// Верхняя панель: общее / необработанные / принятые / отклонённые / критичные /
// предложенные gate к скрытию / прогресс проверки.
export function computeStats(clusters = [], shadowByCluster = new Map(), gateByCluster = new Map()) {
  const stats = {
    total: clusters.length,
    undecided: 0,
    accepted: 0,
    rejected: 0,
    deferred: 0,
    merged: 0,
    critical: 0,
    gate_hidden: 0,
    progress_pct: 0,
  };
  for (const c of clusters) {
    const state = decisionStateOf(c, shadowByCluster.get(c.id) || null);
    if (!state) stats.undecided += 1;
    else stats[state] += 1;
    if (tabOf(c) === 'critical') stats.critical += 1;
    const gate = gateByCluster.get(c.id);
    if (gate && GATE_HIDING.includes(gate.qualification)) stats.gate_hidden += 1;
  }
  const decided = stats.total - stats.undecided;
  stats.progress_pct = stats.total ? Math.round((decided / stats.total) * 100) : 0;
  return stats;
}

// --- Причины решений (зеркало OVERRIDE_REASON_CODES сервера) ------------------

export const DECISION_REASONS = [
  { code: 'no_material_impact', label: 'Нет существенного влияния на ГП' },
  { code: 'already_covered_by_vor', label: 'Уже учтено в ВОР / КП' },
  { code: 'standard_requirement', label: 'Стандартное требование, риска нет' },
  { code: 'incorrect_interpretation', label: 'ИИ неверно истолковал текст ТЗ' },
  { code: 'insufficient_evidence', label: 'Недостаточно доказательств' },
  { code: 'duplicate', label: 'Дубликат другого замечания' },
  { code: 'outside_tender_scope', label: 'Вне рамок данного тендера' },
  { code: 'too_minor', label: 'Слишком незначительно' },
  { code: 'wrong_priority', label: 'Неверный приоритет' },
  { code: 'wrong_action', label: 'Неверное предлагаемое действие' },
  { code: 'other', label: 'Другая причина' },
];

export const REASON_LABELS = Object.fromEntries(DECISION_REASONS.map((r) => [r.code, r.label]));

export const PRIORITIES = [
  { code: 'critical', label: 'Критичный' },
  { code: 'high', label: 'Высокий' },
  { code: 'medium', label: 'Средний' },
  { code: 'low', label: 'Низкий' },
];

// --- Действия инженера --------------------------------------------------------
// accept / edit / reject / defer / merge / priority (+ производные production-
// действия с текстом ТЗ: delete, remove_from_scope).

export const ACTIONS_NEEDING_REASON = ['reject', 'edit'];

// Валидация формы решения ДО отправки. Структурированная причина обязательна
// для отклонения и правки; комментарий обязателен только для причины «other».
export function validateDecisionForm(action, form = {}) {
  const reason = (form.reasonCode || '').trim();
  const comment = (form.comment || '').trim();
  const finalText = (form.finalText || '').trim();
  if (ACTIONS_NEEDING_REASON.includes(action)) {
    if (!reason) return { ok: false, error: 'Выберите причину решения' };
    if (!REASON_LABELS[reason]) return { ok: false, error: 'Недопустимая причина решения' };
    if (reason === 'other' && !comment) {
      return { ok: false, error: 'Для причины «Другая причина» комментарий обязателен' };
    }
  }
  if (action === 'edit' && !finalText) {
    return { ok: false, error: 'Укажите итоговую редакцию замечания' };
  }
  if (action === 'merge' && !form.mergeTargetId) {
    return { ok: false, error: 'Выберите замечание, с которым объединить' };
  }
  if (action === 'priority' && !PRIORITIES.some((p) => p.code === form.priority)) {
    return { ok: false, error: 'Выберите новый приоритет' };
  }
  return { ok: true };
}

// Payload production-решения (review_decisions → экспорт). Для shadow-only
// действий (defer / merge / priority) возвращает null — production-статус
// замечания НЕ меняется, это и есть контракт shadow mode.
export function productionPayloadFor(action, form = {}) {
  const comment = (form.comment || '').trim() || null;
  if (action === 'accept') return { decision: 'accept', final_comment: comment };
  if (action === 'edit') {
    return {
      decision: 'edit',
      edited_redaction: (form.finalText || '').trim(),
      final_comment: comment,
    };
  }
  if (action === 'reject') return { decision: 'reject', final_comment: comment };
  if (action === 'delete') return { decision: 'delete', final_comment: comment };
  if (action === 'remove_from_scope') return { decision: 'remove_from_scope', final_comment: comment };
  return null;
}

// Payload shadow-решения (finding_qualification_decisions): фиксирует вердикт
// инженера по оценке gate со структурированной причиной. ctx — подписи для
// комментария (метка цели объединения, текущий приоритет).
export function shadowPayloadFor(action, form = {}, ctx = {}) {
  const comment = (form.comment || '').trim() || null;
  const reason = (form.reasonCode || '').trim() || null;
  if (action === 'accept') return { decision: 'accepted', reason_code: reason, comment };
  if (action === 'edit') {
    return {
      decision: 'accepted_with_edit',
      reason_code: reason,
      final_text: (form.finalText || '').trim(),
      comment,
    };
  }
  if (action === 'reject') return { decision: 'rejected', reason_code: reason, comment };
  if (action === 'defer') return { decision: 'deferred', reason_code: reason, comment };
  if (action === 'merge') {
    const label = ctx.mergeTargetLabel
      ? `Объединить с: ${ctx.mergeTargetLabel}`
      : 'Объединить с другим замечанием';
    return {
      decision: 'merged',
      reason_code: 'duplicate',
      comment: comment ? `${label}. ${comment}` : label,
    };
  }
  if (action === 'priority') {
    const from = ctx.currentPriority || '—';
    const note = `Приоритет: ${from} → ${form.priority}`;
    return {
      decision: 'deferred',
      reason_code: 'wrong_priority',
      comment: comment ? `${note}. ${comment}` : note,
    };
  }
  if (action === 'delete' || action === 'remove_from_scope') {
    const fallback = action === 'delete' ? 'Принято: удалить из ТЗ' : 'Принято: вынести из объёма ГП';
    return { decision: 'accepted', reason_code: reason, comment: comment || fallback };
  }
  return null;
}

// --- Горячие клавиши ----------------------------------------------------------
// A — принять, E — изменить, R — отклонить, V — на проверку, стрелки —
// следующее/предыдущее. По физическому коду клавиши (evt.code), чтобы работало
// и в русской раскладке. В полях ввода и с модификаторами — не срабатывает.

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

export function hotkeyAction(evt = {}) {
  if (evt.metaKey || evt.ctrlKey || evt.altKey) return null;
  const target = evt.target || {};
  if (TYPING_TAGS.has(String(target.tagName || '').toUpperCase()) || target.isContentEditable) {
    return null;
  }
  const code = evt.code || '';
  if (code === 'KeyA') return 'accept';
  if (code === 'KeyE') return 'edit';
  if (code === 'KeyR') return 'reject';
  if (code === 'KeyV') return 'defer';
  if (code === 'ArrowDown' || code === 'ArrowRight') return 'next';
  if (code === 'ArrowUp' || code === 'ArrowLeft') return 'prev';
  return null;
}

// --- Навигация по списку ------------------------------------------------------

export function clampIndex(length, index) {
  if (!Number.isFinite(length) || length <= 0) return -1;
  return Math.min(Math.max(Number(index) || 0, 0), length - 1);
}

export function moveIndex(length, current, delta) {
  const start = current < 0 ? 0 : current + delta;
  return clampIndex(length, start);
}

// Следующее НЕобработанное замечание после index (циклически); нет таких — null.
export function nextUndecidedIndex(items = [], index, isDecided = () => false) {
  const n = items.length;
  if (!n) return null;
  for (let step = 1; step <= n; step += 1) {
    const i = (index + step) % n;
    if (!isDecided(items[i])) return i;
  }
  return null;
}

// --- Поиск цитаты в тексте ТЗ -------------------------------------------------
// Замечание несёт дословную цитату (representative_fragment). Документ на
// клиенте — Markdown .md ТЗ. Ищем цитату с нормализацией пробелов/кавычек и
// возвращаем ДИАПАЗОН В ИСХОДНЫХ КООРДИНАТАХ текста (для подсветки).
// Длинная цитата, не найденная целиком, ищется по префиксу — совпадение
// помечается exact:false. Не нашли совсем — null (UI показывает предупреждение).

const QUOTE_CHARS = new Set(['«', '»', '„', '“', '”', '"']);
const DASH_CHARS = new Set(['–', '—']);

// Нормализованная строка + карта индексов: map[i] — позиция i-го нормализованного
// символа в исходном тексте.
export function buildSearchIndex(text) {
  const src = String(text || '');
  let norm = '';
  const map = [];
  let pendingSpace = false;
  for (let i = 0; i < src.length; i += 1) {
    let ch = src[i].toLowerCase();
    if (/\s/.test(ch)) {
      pendingSpace = norm.length > 0;
      continue;
    }
    if (QUOTE_CHARS.has(ch)) ch = '"';
    if (DASH_CHARS.has(ch)) ch = '-';
    if (ch === 'ё') ch = 'е';
    if (pendingSpace) {
      norm += ' ';
      map.push(i);
      pendingSpace = false;
    }
    norm += ch;
    map.push(i);
  }
  return { norm, map };
}

export const normalizeForSearch = (s) => buildSearchIndex(s).norm;

const PREFIX_LEN = 80;
const MIN_PREFIX = 32;

export function locateQuote(docText, quote, prebuiltIndex = null) {
  const idx = prebuiltIndex || buildSearchIndex(docText);
  const q = normalizeForSearch(quote);
  if (!q || !idx.norm) return null;
  let matchLen = q.length;
  let pos = idx.norm.indexOf(q);
  let exact = true;
  if (pos < 0 && q.length > PREFIX_LEN) {
    // Длинная цитата могла быть склеена из соседних абзацев или слегка
    // перефразирована — ищем начало, укорачивая префикс по границам слов,
    // пока он остаётся достаточно длинным, чтобы совпадение было осмысленным.
    let prefix = q.slice(0, PREFIX_LEN);
    const firstCut = prefix.lastIndexOf(' ');
    if (firstCut > MIN_PREFIX) prefix = prefix.slice(0, firstCut);
    while (prefix.length >= MIN_PREFIX) {
      pos = idx.norm.indexOf(prefix);
      if (pos >= 0) break;
      const cut = prefix.lastIndexOf(' ');
      if (cut < MIN_PREFIX) break;
      prefix = prefix.slice(0, cut);
    }
    matchLen = prefix.length;
    exact = false;
  }
  if (pos < 0) return null;
  return { start: idx.map[pos], end: idx.map[pos + matchLen - 1] + 1, exact };
}

// Разбивка Markdown-текста на блоки-строки с исходными смещениями (для
// рендера документа и привязки подсветки). Заголовок — строка «#…».
export function splitDocBlocks(text) {
  const src = String(text || '');
  const blocks = [];
  let offset = 0;
  for (const line of src.split('\n')) {
    if (line.trim()) {
      const h = /^(#{1,6})\s+(.*)$/.exec(line.trim());
      blocks.push({
        start: offset,
        end: offset + line.length,
        text: line,
        heading: !!h,
        level: h ? h[1].length : 0,
        title: h ? h[2].trim() : null,
      });
    }
    offset += line.length + 1;
  }
  return blocks;
}

// Заголовок раздела, действующий в позиции offset (ближайший предыдущий «#…»).
export function sectionTitleFor(blocks = [], offset) {
  let title = null;
  for (const b of blocks) {
    if (b.start > offset) break;
    if (b.heading) title = b.title;
  }
  return title;
}

// --- Сохранение состояния просмотра (для пользователя и прогона) --------------

export function reviewStateKey(tenderId, runId, userKey) {
  return `tz_opti.review.${userKey || 'anon'}.${tenderId || 'none'}.${runId || 'no-run'}`;
}

const DEFAULT_STATE = Object.freeze({ tab: 'critical', essential: false, selected_id: null });

export function packReviewState(state = {}) {
  return JSON.stringify({
    tab: TAB_KEYS.includes(state.tab) ? state.tab : DEFAULT_STATE.tab,
    essential: !!state.essential,
    selected_id: state.selected_id || null,
  });
}

// Восстановление устойчиво к мусору в localStorage: любое битое значение —
// дефолты, а не падение страницы.
export function unpackReviewState(raw) {
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object') return { ...DEFAULT_STATE };
    return {
      tab: TAB_KEYS.includes(v.tab) ? v.tab : DEFAULT_STATE.tab,
      essential: !!v.essential,
      selected_id: typeof v.selected_id === 'string' && v.selected_id ? v.selected_id : null,
    };
  } catch (_e) {
    return { ...DEFAULT_STATE };
  }
}

// --- Подписи shadow-слоя (зеркало qualificationShadowService) -----------------

export const GATE_QUALIFICATIONS = {
  publish: 'Показать',
  review: 'На проверку',
  hide: 'Скрыть',
  reject: 'Отклонить',
  evaluation_failed: 'Оценка не посчиталась',
};

export const GATE_QUALIFICATION_CLASSES = {
  publish: 'bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-300',
  review: 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300',
  hide: 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300',
  reject: 'bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-300',
  evaluation_failed: 'bg-orange-100 dark:bg-orange-900/40 text-orange-800 dark:text-orange-300',
};

export const SHADOW_DECISION_LABELS = {
  accepted: 'Принято',
  accepted_with_edit: 'Принято с изменением',
  rejected: 'Отклонено',
  deferred: 'На проверку',
  merged: 'Объединено',
};

// Недостающие обязательные элементы замечания (missing_requirements gate).
export const MISSING_REQUIREMENT_LABELS = {
  exact_quote: 'Нет дословной цитаты ТЗ',
  quote_anchor: 'Цитата не найдена в тексте ТЗ',
  quote_confirms_conclusion: 'Цитата не подтверждает вывод',
  concrete_source: 'Нет конкретного источника (ВОР / чек-лист / Q&A / условие)',
  impact_type: 'Не названо последствие для ГП',
  concrete_action: 'Нет конкретного действия',
};
