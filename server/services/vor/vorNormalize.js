'use strict';

// Нормализация значений ВОР: числа, единицы измерения, наименования.
// Чистый модуль — без БД, без xlsx, без сети (офлайн-тесты).
//
// Зачем отдельно: в реальных ведомостях одно и то же пишут пятью способами
// («1 234,56» / «1234.56» / число Excel; «м2» / «м²» / «кв.м» / «кв. м.»),
// а сравнивать ТЗ ↔ ВОР ↔ чек-лист нужно по ОДНОМУ представлению.

// ── Числа ────────────────────────────────────────────────────────────────────
// Пробелы-разделители разрядов бывают неразрывными ( ), узкими ( ,
//  ) и обычными; минус — как «-», так и «−»/«–».
const SPACE_CHARS = /[\s    ']/g;
const MINUS_CHARS = /[−–—]/g;

// Из ячейки вида «120 м3» / «≈ 1 200,5» / «(15)» достаём числовую часть.
// Диапазон («10-12») — не число: величина неоднозначна, отдаём null и
// сохраняем сырое значение (инженер увидит исходник).
const NUMERIC_BODY = /^[+-]?[\d.,]+$/;
const RANGE = /^\d[\d\s   '.,]*-[\d\s   '.,]*\d/;
const LEADING_NUMBER = /^[+-]?\d[\d\s   '.,]*/;

function normalizeNumber(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'boolean') return null;
  if (raw instanceof Date) return null;

  let s = String(raw).replace(MINUS_CHARS, '-').trim();
  if (!s) return null;
  // Служебные приставки приблизительности и скобки-обёртки.
  s = s.replace(/^[≈~=±]+/, '').trim();
  if (/^\(.*\)$/.test(s)) s = s.slice(1, -1).trim();
  if (RANGE.test(s)) return null;
  // Хвост в той же ячейке («120 м3», «15 шт.») — отбрасываем: единицу читает
  // normalizeUnit, здесь нужна только величина.
  const lead = s.match(LEADING_NUMBER);
  if (!lead) return null;
  s = lead[0].replace(SPACE_CHARS, '').replace(/[.,]+$/, '');
  if (!s || !NUMERIC_BODY.test(s)) return null;

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    // Присутствуют оба: разделитель дробной части — тот, что правее.
    const decimalSep = lastComma > lastDot ? ',' : '.';
    const thousandSep = decimalSep === ',' ? '.' : ',';
    s = s.split(thousandSep).join('');
    s = s.replace(decimalSep, '.');
  } else if (lastComma >= 0) {
    // Только запятые: «1,234,567» — разряды, «1,5» — дробная часть.
    const parts = s.split(',');
    const thousandsShaped =
      parts.length > 2 && parts.slice(1).every((p) => /^\d{3}$/.test(p));
    s = thousandsShaped ? parts.join('') : `${parts.slice(0, -1).join('')}.${parts[parts.length - 1]}`;
  } else if (lastDot >= 0) {
    const parts = s.split('.');
    if (parts.length > 2 && parts.slice(1).every((p) => /^\d{3}$/.test(p))) s = parts.join('');
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// ── Единицы измерения ────────────────────────────────────────────────────────
// Канонические единицы, к которым приводим всё многообразие записей.
// Ключ словаря — «сжатая» форма (нижний регистр, без пробелов/точек).
const UNIT_ALIASES = new Map(Object.entries({
  // площадь
  м2: 'м2', 'м²': 'м2', квм: 'м2', квадратныйметр: 'м2', квадратныеметры: 'м2',
  m2: 'м2', sqm: 'м2', 'м^2': 'м2', 'м2)': 'м2',
  // объём
  м3: 'м3', 'м³': 'м3', кубм: 'м3', мкуб: 'м3', кубическийметр: 'м3',
  m3: 'м3', cbm: 'м3', 'м^3': 'м3',
  // длина
  м: 'м', пм: 'м', погм: 'м', мп: 'м', погонныйметр: 'м', погонныеметры: 'м',
  метр: 'м', метры: 'м', метров: 'м', m: 'м', мпог: 'м',
  км: 'км', мм: 'мм', см: 'см',
  // масса
  т: 'т', тн: 'т', тонн: 'т', тонна: 'т', тонны: 'т', тна: 'т',
  кг: 'кг', килограмм: 'кг', г: 'г',
  // счётные
  шт: 'шт', штук: 'шт', штука: 'шт', штуки: 'шт', ед: 'шт', едизм: 'шт',
  единиц: 'шт', pcs: 'шт',
  компл: 'компл', комплект: 'компл', комплекта: 'компл', комплектов: 'компл',
  кт: 'компл', 'к-т': 'компл', кс: 'компл', 'к-с': 'компл',
  точка: 'точка', точек: 'точка', точки: 'точка',
  место: 'место', мест: 'место',
  секция: 'секция', секций: 'секция',
  // трудозатраты и машины
  челч: 'чел-ч', 'чел-ч': 'чел-ч', челчас: 'чел-ч', человекочас: 'чел-ч',
  машч: 'маш-ч', 'маш-ч': 'маш-ч', машчас: 'маш-ч', машиночас: 'маш-ч',
  чел: 'чел', человек: 'чел',
  смен: 'смена', смена: 'смена', смены: 'смена',
  мес: 'мес', месяц: 'мес', месяцев: 'мес', сут: 'сут', сутки: 'сут',
  ч: 'ч', час: 'ч', часов: 'ч',
  // прочее
  л: 'л', литр: 'л', литров: 'л',
  '%': '%', процент: '%', процентов: '%',
  усл: 'усл.ед', услед: 'усл.ед', уе: 'усл.ед',
}));

// Сжатая форма: нижний регистр, ё→е, без пробелов/точек/скобок.
function unitKey(raw) {
  return String(raw == null ? '' : raw)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[\s .,;:"'()·]/g, '')
    .replace(/^-+|-+$/g, '');
}

// Возвращает { unit, raw, known }: unit — каноническая единица (или очищенная
// исходная, если незнакома), known — распозналась ли она словарём.
function normalizeUnit(raw) {
  const rawStr = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  if (!rawStr) return { unit: '', raw: '', known: false };

  const key = unitKey(rawStr);
  if (UNIT_ALIASES.has(key)) return { unit: UNIT_ALIASES.get(key), raw: rawStr, known: true };

  // «м2 покрытия», «шт." » и прочие хвосты: пробуем первый токен.
  const head = unitKey(rawStr.split(/[\s/]+/)[0]);
  if (UNIT_ALIASES.has(head)) return { unit: UNIT_ALIASES.get(head), raw: rawStr, known: true };

  // Записи через степень («м 2», «м. п.») уже схлопнуты unitKey; остаётся
  // вариант с множителем («100 м2», «1000 шт») — берём буквенный хвост.
  const tail = unitKey(rawStr.replace(/^[\d\s.,]+/, ''));
  if (UNIT_ALIASES.has(tail)) return { unit: UNIT_ALIASES.get(tail), raw: rawStr, known: true };

  return { unit: rawStr.toLowerCase(), raw: rawStr, known: false };
}

// ── Текст ────────────────────────────────────────────────────────────────────
function normalizeText(raw) {
  if (raw === null || raw === undefined) return '';
  if (raw instanceof Date) return raw.toISOString().slice(0, 10);
  if (typeof raw === 'number') return String(raw);
  return String(raw)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[   ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Ключ наименования для дедупа и сопоставления: без регистра, без пунктуации,
// ё→е. Цифры СОХРАНЯЕМ (толщина/диаметр/марка отличают работы друг от друга).
function nameKey(raw) {
  return normalizeText(raw)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"'()\[\]{}.,;:!?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const HAS_LETTER = /[A-Za-zА-Яа-яЁё]/;
const hasLetter = (s) => HAS_LETTER.test(String(s == null ? '' : s));

module.exports = {
  normalizeNumber,
  normalizeUnit,
  normalizeText,
  nameKey,
  unitKey,
  hasLetter,
  UNIT_ALIASES,
};
