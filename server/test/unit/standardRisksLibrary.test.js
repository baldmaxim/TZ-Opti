'use strict';

// Библиотека типовых рисков (db/standardRisks) и шаблон существенных условий
// (db/conditionsTemplate): целостность справочников, на которых стоят Стадии
// 3–4. Библиотека обязана покрывать группы реального тендера на ЖК, а не только
// демонстрационное ядро; условия компании не должны иметь пустого стандарта.
// Запуск: npm run test:unit.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { STANDARD_RISKS } = require('../../db/standardRisks');
const { CONDITIONS_GEN, CONDITIONS_SHELL } = require('../../db/conditionsTemplate');
const { COVERAGE_TOPICS } = require('../../services/stageAnalysis/conditionCoverage');

const CRITICALITIES = ['low', 'medium', 'high', 'critical'];

test('каждый риск полный: ключ, категория, текст, триггеры, рекомендация, критичность', () => {
  for (const r of STANDARD_RISKS) {
    assert.match(r.key, /^R\d{2}$/, `ключ ${r.key}`);
    assert.ok((r.category || '').trim(), `${r.key}: категория`);
    assert.ok((r.risk_text || '').trim().length >= 20, `${r.key}: формулировка риска`);
    assert.ok(Array.isArray(r.triggers) && r.triggers.filter(Boolean).length >= 1, `${r.key}: триггеры`);
    assert.ok((r.recommendation || '').trim(), `${r.key}: рекомендация компании`);
    assert.ok(CRITICALITIES.includes(r.criticality), `${r.key}: критичность`);
  }
});

test('ключи рисков уникальны, ядро R01–R15 сохранено (по ним живут overlay тендеров)', () => {
  const keys = STANDARD_RISKS.map((r) => r.key);
  assert.equal(new Set(keys).size, keys.length, 'дубликатов нет');
  for (let i = 1; i <= 15; i += 1) {
    assert.ok(keys.includes(`R${String(i).padStart(2, '0')}`), `ядро R${i}`);
  }
  assert.ok(STANDARD_RISKS.length >= 35, `библиотека реального тендера (${STANDARD_RISKS.length} рисков)`);
});

test('библиотека покрывает группы реального ЖК-тендера (не только 15 универсальных)', () => {
  const categories = new Set(STANDARD_RISKS.map((r) => r.category));
  for (const expected of [
    'Состав и границы работ',
    'Цена и изменения',
    'Дополнительные работы',
    'Проект и исходные данные',
    'Сроки',
    'Фронт работ и доступ',
    'Временные сети и ресурсы',
    'Логистика и содержание площадки',
    'Согласование материалов',
    'Поставщики и подрядчики Заказчика',
    'Исполнительная документация',
    'Качество и приёмка',
    'Оплата и обеспечение',
    'Штрафы и лимиты ответственности',
    'Страхование',
    'Ответственность и гарантии',
    'ПНР и ввод',
    'Непредвиденные условия',
    'Остановка и расторжение',
    'Приоритет документов',
    'Городские и проектные ограничения',
    'Информационные модели и данные',
    'Конфиденциальность и права',
  ]) {
    assert.ok(categories.has(expected), `группа «${expected}»`);
  }
});

test('РЕГРЕСС: в шаблоне условий нет пунктов с пустым стандартом компании', () => {
  for (const [kind, set] of [['gen', CONDITIONS_GEN], ['shell', CONDITIONS_SHELL]]) {
    for (const c of set) {
      if (c.dynamic) continue; // динамические рендерятся из параметров тендера
      assert.ok((c.text || '').trim().length > 0, `${kind} idx=${c.idx} «${c.name}»: пустой текст`);
    }
  }
});

test('«Работы, не предусмотренные в Договоре» и «К вниманию Заказчика» защищают ГП по существу', () => {
  // ВАЖНО: \w в JS-регексах не матчит кириллицу — только буквальные формы.
  for (const set of [CONDITIONS_GEN, CONDITIONS_SHELL]) {
    const extra = set.find((c) => c.name.startsWith('Работы, не предусмотренные'));
    assert.match(extra.text, /дополнительного соглашения/i, 'доп. работы только по ДС');
    assert.match(extra.text, /до начала/i, 'цена и срок до начала работ');
    const attention = set.find((c) => c.name === 'К вниманию Заказчика');
    assert.match(attention.text, /фронт/i, 'передача фронта — условие КП');
    assert.match(attention.text, /сдвигает сроки/i, 'задержки Заказчика сдвигают сроки');
  }
});

test('темы покрытия: отсутствие защитных механизмов ловится по всем группам (24 темы, ключи уникальны)', () => {
  const keys = COVERAGE_TOPICS.map((t) => t.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(COVERAGE_TOPICS.length >= 24, `тем покрытия: ${COVERAGE_TOPICS.length}`);
  for (const expected of [
    'pnr_commissioning', 'insurance_smr', 'termination_consequences',
    'design_error_liability', 'customer_materials', 'bim_data',
    'confidentiality_ip', 'city_restrictions',
  ]) {
    assert.ok(keys.includes(expected), `тема ${expected}`);
  }
});
