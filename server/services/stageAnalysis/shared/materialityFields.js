'use strict';

// ОБЩИЙ блок оценки материальности для находок стадий 1–4 — один фрагмент
// JSON-схемы + один кусок промта на все стадии.
//
// Зачем. Публикацию замечания теперь решают impact_level (насколько дорого ГП) и
// evidence_level (насколько подтверждено) — см. services/review/materiality.js.
// Агент стадии обязан оценить ИМЕННО ЭТИ ДВЕ ОСИ, а не только criticality:
// criticality осталась легаси-полем сортировки и на публикацию не влияет.
//
// Что делает сервер с этими полями:
//   • impact_dimensions — объединяются с измерениями, выведенными критериями
//     critic (детерминированно, по тексту фрагмента);
//   • evidence_level — может только ПОНИЗИТЬ структурную оценку сервера
//     (нет цитаты/обоснования → weak, что бы модель ни заявила);
//   • materiality_flag ≠ material — жёсткое подавление (редактура, дубль,
//     стандартное требование, нет влияния, неподтверждённое предположение);
//   • impact_level — сохраняется в draft_issue как «мнение агента»; итоговый
//     уровень влияния считает critic по материальным критериям компании.
// Поля НЕобязательные: стадия, которая их не вернула, не ломается — сервер
// посчитает всё сам (fail-closed).

const {
  IMPACT_LEVELS,
  EVIDENCE_LEVELS,
  IMPACT_DIMENSIONS,
  SUPPRESSION_FLAGS,
} = require('../../review/materiality');

// Значение флага «замечание материально» (по умолчанию).
const MATERIAL_FLAG = 'material';

// Фрагмент JSON-схемы находки (properties). Добавляется к properties каждой
// стадии; ни одно поле не попадает в required — контракт стадий не жёстче.
const MATERIALITY_PROPERTIES = Object.freeze({
  impact_level: {
    type: 'string',
    enum: [...IMPACT_LEVELS],
    description:
      'НАСКОЛЬКО ДОРОГО это Генподрядчику: critical/high — прямые деньги, срок или ' +
      'договорная ответственность; medium — ограниченное влияние; low — почти ничего; ' +
      'none — влияния на цену/срок/оплату/договор/ответственность/объём нет. ' +
      'Это НЕ criticality и НЕ уверенность в находке.',
  },
  evidence_level: {
    type: 'string',
    enum: [...EVIDENCE_LEVELS],
    description:
      'НАСКОЛЬКО ПОДТВЕРЖДЕНО текстом ТЗ и справочниками: strong — дословная ' +
      'формулировка ТЗ прямо порождает риск и подтверждена справочником (ВОР / ' +
      'чек-лист / Q&A / условия / реестр рисков); medium — формулировка есть, но ' +
      'вывод требует толкования; weak — вывод по косвенным признакам или ' +
      'предположение. Это НЕ confidence.',
  },
  impact_dimensions: {
    type: 'array',
    items: { type: 'string', enum: [...IMPACT_DIMENSIONS] },
    description:
      'На что именно влияет: price (стоимость/расчёт/КП), schedule (срок/график), ' +
      'payment (приёмка/оплата/удержания), contract (договорные условия), ' +
      'responsibility (обязанности/ответственность/гарантия), scope (объём работ ГП). ' +
      'Пустой массив — если ни на что из перечисленного.',
  },
  materiality_flag: {
    type: 'string',
    enum: [MATERIAL_FLAG, ...SUPPRESSION_FLAGS],
    description:
      'material — обычное замечание. Иначе — почему замечание НЕ материально: ' +
      'editorial (редактура/оформление), duplicate (дубль другого замечания), ' +
      'standard_requirement (стандартное требование нормативов/обычной практики), ' +
      'no_impact (не влияет на коммерческие и договорные условия), ' +
      'unconfirmed_assumption (предположение, не подтверждённое текстом ТЗ). ' +
      'Такие находки НЕ выбрасывай — помечай флагом, инженер увидит их в полном режиме.',
  },
});

// Блок системного промта — добавляется к SHARED каждой стадии.
const MATERIALITY_PROMPT = [
  'ОЦЕНКА МАТЕРИАЛЬНОСТИ (обязательна для КАЖДОЙ находки — по ней решается,',
  'увидит ли замечание инженер по умолчанию):',
  '• impact_level — насколько это дорого ГП: critical/high (прямые деньги, срок,',
  '  договорная ответственность), medium (ограниченное влияние), low (мелочь),',
  '  none (не влияет на цену/срок/оплату/договор/ответственность/объём).',
  '• evidence_level — насколько это подтверждено: strong (дословная формулировка',
  '  ТЗ прямо порождает риск и подтверждена справочником), medium (формулировка',
  '  есть, вывод требует толкования), weak (косвенно / предположение).',
  '• impact_dimensions — на что влияет: price, schedule, payment, contract,',
  '  responsibility, scope (можно несколько; пусто — если ни на что).',
  '• materiality_flag — material для обычного замечания; editorial / duplicate /',
  '  standard_requirement / no_impact / unconfirmed_assumption — если замечание',
  '  НЕ материально (редактура, дубль, стандартное требование, нет влияния,',
  '  неподтверждённое предположение). Такие находки не выбрасывай — помечай.',
  '',
  'ЭТО НЕ criticality И НЕ confidence. criticality — величина риска по твоей',
  'шкале, confidence — твоя уверенность в самой находке. Публикацию решают',
  'ТОЛЬКО impact_level и evidence_level: замечание с impact_level=low не',
  'публикуется, даже если confidence=0.99; замечание с impact_level=high и',
  'evidence_level=weak уходит инженеру НА ПРОВЕРКУ, а не в основной список.',
  'Поэтому не завышай impact_level ради внимания и не занижай evidence_level',
  'из осторожности — оценивай честно.',
].join('\n');

// Добавляет блок материальности к properties схемы находки стадии.
// Возвращает НОВЫЙ объект (исходную схему не мутирует).
function withMaterialityProperties(properties) {
  return { ...(properties || {}), ...MATERIALITY_PROPERTIES };
}

// Добавляет блок материальности к системному промту стадии.
function withMaterialityPrompt(prompt) {
  return `${prompt}\n\n${MATERIALITY_PROMPT}`;
}

// Достраивает RESPONSE_SCHEMA стадии (findings[].properties) блоком
// материальности. Стадии оборачивают этим свой литерал схемы — так поля живут в
// ОДНОМ месте, а не копируются в четыре файла.
function attachMateriality(schema) {
  const items = schema
    && schema.properties
    && schema.properties.findings
    && schema.properties.findings.items;
  if (!items) throw new Error('attachMateriality: ожидалась схема с properties.findings.items');
  items.properties = withMaterialityProperties(items.properties);
  return schema;
}

module.exports = {
  MATERIAL_FLAG,
  MATERIALITY_PROPERTIES,
  MATERIALITY_PROMPT,
  withMaterialityProperties,
  withMaterialityPrompt,
  attachMateriality,
};
