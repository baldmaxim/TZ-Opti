'use strict';

// Юнит-тесты слоя critic (значимость draft_issue для генподрядчика) — без БД и LLM.
// Проверяют чистое ядро evaluateDraft/reviewDrafts: важное показывается, малозначимое
// скрывается (show_to_engineer=0), но НЕ удаляется. Запуск: npm test.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { evaluateDraft, reviewDrafts } = require('../services/critic/criticService');

// --- Фабрики фикстур --------------------------------------------------------

// draft_issue в форме, которую отдаёт unifiedIssueBuilder (поля, что читает critic).
function draft(extra = {}) {
  return {
    id: extra.id || 'd1',
    tz_clause: null,
    source_fragment: null,
    problem_type: null,
    category: 'decision',
    basis: null,
    review_comment: null,
    confidence: 0.7,
    created_from_signal_ids: [],
    paragraph_index: 0,
    ...extra,
  };
}

// Плоский сигнал-источник в форме flattenSignal внутри critic.
function signal(criticality, extra = {}) {
  return { id: extra.id || 's1', problem_type: null, risk_category: null, criticality, ...extra };
}

// --- ВАЖНЫЕ замечания (показываются инженеру) -------------------------------

test('важное #1: условие договора противоречит компании -> critical, показывается', () => {
  const d = draft({
    id: 'imp1', category: 'condition', problem_type: 'условие_противоречит',
    confidence: 0.95,
    source_fragment: 'Данное условие договора противоречит существенным условиям компании.',
    basis: 'Договорное условие в пользу заказчика, противоречит политике ГП.',
  });
  const r = evaluateDraft(d, [signal('critical', { risk_category: 'договорной' })]);
  assert.equal(r.show_to_engineer, true);
  assert.equal(r.display_priority, 'critical');
  assert.equal(r.contract_impact, 'high');
  assert.ok(r.criteria.includes('affects_contract'));
  assert.ok(r.criteria.includes('contradicts_company'));
});

test('важное #2: расширение объёма + новая обязанность ГП -> high, показывается', () => {
  const d = draft({
    id: 'imp2', category: 'risk',
    source_fragment: 'Подрядчик обязуется выполнить весь комплекс работ собственными силами и за свой счёт.',
    basis: 'Возлагает на ГП неоплачиваемые работы — рост себестоимости.',
  });
  const r = evaluateDraft(d, [signal('high', { risk_category: 'объём_и_обязательства' })]);
  assert.equal(r.show_to_engineer, true);
  assert.ok(['critical', 'high'].includes(r.display_priority), `priority=${r.display_priority}`);
  assert.ok(r.criteria.includes('expands_scope'));
  assert.ok(r.criteria.includes('new_obligation'));
  assert.equal(r.responsibility_impact, 'high');
});

test('важное #3: работы не учтены ни в КП, ни в ВОР -> high, показывается', () => {
  const d = draft({
    id: 'imp3', category: 'coverage', problem_type: 'не_в_обоих',
    source_fragment: 'Демонтаж существующих конструкций не учтён ни в КП, ни в ВОР — влияет на расчёт стоимости работ.',
    basis: 'Объём работ без расценки в КП — прямое удорожание.',
  });
  const r = evaluateDraft(d, [signal('high', { risk_category: 'покрытие_расчёта' })]);
  assert.equal(r.show_to_engineer, true);
  assert.equal(r.display_priority, 'high');
  assert.equal(r.price_impact, 'high');
  assert.ok(r.criteria.includes('affects_calc'));
  assert.ok(r.criteria.includes('affects_kp'));
});

// --- МАЛОЗНАЧИМЫЕ замечания (хранятся, но скрыты по умолчанию) ---------------

test('скрыто #1: опечатка в нумерации -> low, скрыто, нет влияния', () => {
  const d = draft({
    id: 'hid1',
    source_fragment: 'В пункте 4.3 опечатка в нумерации подпунктов, перепутана последовательность букв.',
    basis: 'Редакционная неточность.',
  });
  const r = evaluateDraft(d, [signal('low')]);
  assert.equal(r.show_to_engineer, false);
  assert.equal(r.display_priority, 'low');
  assert.equal(r.business_impact, 'none');
  assert.deepEqual(r.criteria, []);
});

test('скрыто #2: несоответствие сквозной нумерации таблиц -> low, скрыто', () => {
  const d = draft({
    id: 'hid2',
    source_fragment: 'Несоответствие нумерации таблиц в приложении 2 сквозной нумерации документа.',
    basis: 'Оформительская мелочь.',
  });
  const r = evaluateDraft(d, [signal('low')]);
  assert.equal(r.show_to_engineer, false);
  assert.equal(r.display_priority, 'low');
});

test('скрыто #3: слабое одиночное замечание (нет информации) -> low, скрыто', () => {
  const d = draft({
    id: 'hid3', problem_type: 'qa_отсутствует_информация',
    source_fragment: 'По вопросу о цвете финишного покрытия информация в ТЗ отсутствует.',
    basis: 'Уточнить у заказчика.',
  });
  const r = evaluateDraft(d, [signal('low')]);
  assert.equal(r.show_to_engineer, false);
  assert.equal(r.display_priority, 'low');
  assert.equal(r.business_impact, 'low'); // сработал слабый критерий — не none
});

// --- Инвариант: малозначимое НЕ удаляется -----------------------------------

test('reviewDrafts оценивает ВСЕ драфты (скрытые не выпадают из набора)', () => {
  const drafts = [
    draft({ id: 'a', category: 'condition', problem_type: 'условие_противоречит', source_fragment: 'противоречит договору', created_from_signal_ids: ['sa'] }),
    draft({ id: 'b', source_fragment: 'опечатка в нумерации', created_from_signal_ids: ['sb'] }),
  ];
  const signalsById = new Map([
    ['sa', signal('critical', { id: 'sa', risk_category: 'договорной' })],
    ['sb', signal('low', { id: 'sb' })],
  ]);
  const out = reviewDrafts(drafts, signalsById);
  assert.equal(out.length, 2, 'на выходе столько же записей, сколько драфтов');
  const hidden = out.filter((o) => !o.review.show_to_engineer);
  assert.equal(hidden.length, 1, 'малозначимое помечено скрытым, но присутствует');
  assert.ok(out.every((o) => typeof o.review.display_priority === 'string'));
});

// --- Режим показа: working скрывает low, full показывает всё ------------------
// (MODE_WHERE — SQL; здесь проверяем семантику предиката на оценённых драфтах.)

test('предикат режимов: important=critical|high, working=скрыт low, full=всё', () => {
  const evals = [
    evaluateDraft(draft({ category: 'condition', problem_type: 'условие_противоречит', source_fragment: 'противоречит договору компании' }), [signal('critical', { risk_category: 'договорной' })]),
    evaluateDraft(draft({ source_fragment: 'опечатка в нумерации пунктов' }), [signal('low')]),
  ];
  const important = evals.filter((e) => ['critical', 'high'].includes(e.display_priority));
  const working = evals.filter((e) => e.show_to_engineer);
  const full = evals;
  assert.equal(important.length, 1);
  assert.equal(working.length, 1);
  assert.equal(full.length, 2);
});
