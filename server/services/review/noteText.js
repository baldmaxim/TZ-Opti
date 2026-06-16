'use strict';

// Гуманизация служебных токенов анализатора в текстах для инженера.
// LLM-агент Стадии 1 иногда тащит имя колонки чек-листа in_calc прямо в
// человеческий текст (basis/рекомендация): 1 — ГП выполняет, 0 — не выполняет,
// null — статус не определён. Чистим на выходе всех cluster-level выгрузок
// (.docx-комментарии, md/csv/summary, preview), чтобы инженер не видел сырьё.
// Зеркало клиентского humanizeNote из client/src/utils/format.js — держать в
// синхроне (общего shared-модуля в проекте нет).
//
// НЕ применять к source_fragment — это дословная цитата ТЗ.

// Разделитель опционален: ловит и «in_calc=0», и «in_calc 0», и
// «in_calc не определён» (агент пишет имя поля и без знака равенства).
const IN_CALC_RE = /\bin[_\s]?calc\s*[=:]?\s*(1|0|null|не\s*определ[её]н\w*)/gi;

function humanizeNoteText(text) {
  if (!text) return text;
  return String(text).replace(IN_CALC_RE, (_m, val) => {
    const v = String(val).toLowerCase();
    if (v === '1') return 'входит в объём ГП';
    if (v === '0') return 'не входит в объём ГП';
    return 'статус не определён';
  });
}

module.exports = { humanizeNoteText };
