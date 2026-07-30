'use strict';

// Экспорт формы «Вопрос–Ответ» в .xlsx. Переиспользует тот же xlsx (SheetJS),
// что и импорт (qaImportService) — отдельной зависимости не добавляем. Колонки
// зеркалят исходную форму + поля разметки анализа (пункт ТЗ, отражение, контуры),
// чтобы выгрузка была полным «снимком» рабочей таблицы Q&A.

const XLSX = require('xlsx');
const db = require('../db/connection');

const STATUS_LABEL = { active: 'действует', superseded: 'заменён', cancelled: 'отменён' };

const COLUMNS = [
  { header: '№', get: (_q, i) => i + 1 },
  { header: 'Раздел', get: (q) => q.section || '' },
  { header: 'Раунд', get: (q) => q.round_label || '' },
  { header: 'Статус', get: (q) => STATUS_LABEL[q.status || 'active'] || q.status || '' },
  { header: 'Вопрос', get: (q) => q.question || '' },
  { header: 'Ответ Заказчика', get: (q) => q.answer || '' },
  { header: 'Принятые решения', get: (q) => q.accepted_decision || '' },
  { header: 'Пункт ТЗ', get: (q) => q.tz_clause || '' },
  { header: 'Отражено в ТЗ', get: (q) => (q.tz_reflected ? 'да' : '') },
  { header: 'Противоречит ТЗ', get: (q) => (q.tz_contradicts ? 'да' : '') },
  { header: 'Влияет на расчёт', get: (q) => (q.affects_calc ? 'да' : '') },
  { header: 'Влияет на КП', get: (q) => (q.affects_kp ? 'да' : '') },
  { header: 'Влияет на договор', get: (q) => (q.affects_contract ? 'да' : '') },
  { header: 'Влияет на график', get: (q) => (q.affects_schedule ? 'да' : '') },
];

// Строит Buffer .xlsx из строк Q&A тендера (порядок — как в таблице: order_idx).
async function exportQaXlsx(tenderId) {
  const items = await db.queryAll(
    'SELECT * FROM qa_entries WHERE tender_id = ? ORDER BY order_idx ASC',
    tenderId,
  );
  const aoa = [COLUMNS.map((c) => c.header)];
  items.forEach((q, i) => aoa.push(COLUMNS.map((c) => c.get(q, i))));

  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  // Разумная ширина колонок, чтобы файл открывался читаемым.
  sheet['!cols'] = [
    { wch: 4 }, { wch: 18 }, { wch: 16 }, { wch: 10 }, { wch: 50 }, { wch: 50 }, { wch: 40 },
    { wch: 14 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 14 }, { wch: 14 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, 'Q&A');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { exportQaXlsx };
