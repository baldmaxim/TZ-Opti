'use strict';

// Юнит-тесты единого реестра действий (services/analysis/actions.js) — без БД и
// LLM. Проверяют: канон каждого действия, легаси-алиас edit→replace, семейства
// (в т.ч. регресс «replace → modify», а не note) и фаззи-нормализацию.
// Запуск: npm test.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  ACTIONS,
  ALL_ACTIONS,
  FAMILY,
  isAction,
  canonicalAction,
  coerceAction,
  actionFamily,
} = require('../../services/analysis/actions');

// Ожидаемое семейство для каждого канонического действия.
const EXPECTED_FAMILY = {
  delete: 'remove',
  remove_from_scope: 'remove',
  replace: 'modify',
  limit_scope: 'modify',
  clarify: 'note',
  assumption: 'note',
  comment: 'note',
};

// --- состав enum ---------------------------------------------------------------

test('ALL_ACTIONS содержит ровно 7 поддерживаемых действий', () => {
  assert.deepEqual(
    [...ALL_ACTIONS].sort(),
    ['assumption', 'clarify', 'comment', 'delete', 'limit_scope', 'remove_from_scope', 'replace'].sort(),
  );
  assert.equal(ALL_ACTIONS.length, 7);
});

test('legacy edit НЕ входит в enum действий (только алиас)', () => {
  assert.equal(isAction('edit'), false);
  assert.equal(isAction('replace'), true);
});

// --- по одному тесту на каждое действие ----------------------------------------

for (const action of ['delete', 'remove_from_scope', 'replace', 'limit_scope', 'clarify', 'assumption', 'comment']) {
  test(`действие «${action}»: канон = само себя, семейство = ${EXPECTED_FAMILY[action]}`, () => {
    assert.equal(canonicalAction(action), action, 'каноническое значение неизменно');
    assert.equal(actionFamily(action), EXPECTED_FAMILY[action]);
    // Регистр/пробелы/дефисы нормализуются к тому же канону.
    assert.equal(canonicalAction(` ${action.toUpperCase().replace(/_/g, '-')} `), action);
  });
}

// --- регресс: replace → modify (не note) ---------------------------------------

test('РЕГРЕСС: actionFamily(replace) === modify (а НЕ note)', () => {
  assert.equal(actionFamily('replace'), FAMILY.MODIFY);
  assert.notEqual(actionFamily('replace'), FAMILY.NOTE);
});

test('РЕГРЕСС: limit_scope тоже modify, не note', () => {
  assert.equal(actionFamily('limit_scope'), FAMILY.MODIFY);
  assert.notEqual(actionFamily('limit_scope'), FAMILY.NOTE);
});

// --- back-compat: edit → replace → modify --------------------------------------

test('legacy edit → replace (обратная совместимость)', () => {
  assert.equal(canonicalAction('edit'), ACTIONS.REPLACE);
  assert.equal(canonicalAction('EDIT'), ACTIONS.REPLACE);
});

test('legacy edit попадает в семейство modify (через replace)', () => {
  assert.equal(actionFamily('edit'), FAMILY.MODIFY);
});

// --- неизвестные значения / fallback -------------------------------------------

test('неизвестное действие → fallback (по умолчанию comment / note)', () => {
  assert.equal(canonicalAction('нечто'), ACTIONS.COMMENT);
  assert.equal(actionFamily('нечто'), FAMILY.NOTE);
  assert.equal(canonicalAction('нечто', ACTIONS.CLARIFY), ACTIONS.CLARIFY);
});

test('пустое / null действие → fallback', () => {
  assert.equal(canonicalAction(''), ACTIONS.COMMENT);
  assert.equal(canonicalAction(null), ACTIONS.COMMENT);
  assert.equal(canonicalAction(undefined, ACTIONS.CLARIFY), ACTIONS.CLARIFY);
});

// --- coerceAction: фаззи-интерпретация свободного текста LLM --------------------

test('coerceAction: русские/синонимичные формулировки → канон', () => {
  assert.equal(coerceAction('Заменить формулировку'), ACTIONS.REPLACE);
  assert.equal(coerceAction('удалить пункт'), ACTIONS.DELETE);
  assert.equal(coerceAction('вынести из объёма ГП'), ACTIONS.REMOVE_FROM_SCOPE);
  assert.equal(coerceAction('ограничить объём'), ACTIONS.LIMIT_SCOPE);
  assert.equal(coerceAction('зафиксировать допущение'), ACTIONS.ASSUMPTION);
  assert.equal(coerceAction('уточнить у заказчика'), ACTIONS.CLARIFY);
  assert.equal(coerceAction('просто примечание'), ACTIONS.COMMENT);
});

test('coerceAction: «вынести» приоритетнее «удалить» (порядок фаззи-правил)', () => {
  assert.equal(coerceAction('вынести/удалить из объёма'), ACTIONS.REMOVE_FROM_SCOPE);
});

test('coerceAction: точное каноническое значение проходит без фаззи', () => {
  for (const a of ALL_ACTIONS) assert.equal(coerceAction(a), a);
});
