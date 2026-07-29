'use strict';

// Чистая логика страницы инженерной проверки замечаний ИИ
// (client/src/utils/reviewBoard.js). Покрытие по ТЗ переработки страницы:
// фильтрация, вкладки, сохранение решения, обязательная причина отклонения,
// навигация, горячие клавиши, отсутствующая цитата, сохранение состояния и
// ГЛАВНЫЙ ИНВАРИАНТ shadow mode — gate и shadow-действия не меняют
// production-статус замечания.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const CLIENT_UTIL = pathToFileURL(
  path.join(__dirname, '..', '..', '..', 'client', 'src', 'utils', 'reviewBoard.js'),
).href;

const load = () => import(CLIENT_UTIL);

// Кластеры всех полок: 2 критичных, рабочий, на проверку, низкий, скрытый.
function sampleClusters() {
  return [
    { id: 'c1', verdict: 'publish', overall_impact_level: 'critical' },
    { id: 'c2', verdict: 'publish', overall_impact_level: 'high' },
    { id: 'c3', verdict: 'publish', overall_impact_level: 'medium' },
    { id: 'c4', verdict: 'verify', overall_impact_level: 'high' },
    { id: 'c5', verdict: 'suppress', overall_impact_level: 'low' },
    { id: 'c6', verdict: 'suppress', overall_impact_level: 'medium', suppression_reason: 'дубль' },
  ];
}

// --- Вкладки -----------------------------------------------------------------

test('вкладки: tabOf раскладывает по полкам материальности', async () => {
  const { tabOf } = await load();
  assert.equal(tabOf({ verdict: 'publish', overall_impact_level: 'critical' }), 'critical');
  assert.equal(tabOf({ verdict: 'publish', overall_impact_level: 'high' }), 'critical');
  assert.equal(tabOf({ verdict: 'publish', overall_impact_level: 'medium' }), 'working');
  assert.equal(tabOf({ verdict: 'verify', overall_impact_level: 'critical' }), 'review');
  assert.equal(tabOf({ verdict: 'suppress', overall_impact_level: 'low' }), 'low');
  assert.equal(tabOf({ verdict: 'suppress', overall_impact_level: 'none' }), 'low');
  // Скрыто фильтром не из-за низкого влияния (дубль, редактура) — отдельная вкладка.
  assert.equal(tabOf({ verdict: 'suppress', overall_impact_level: 'medium' }), 'hidden');
  // Легаси-прогон без вердикта — по criticality; совсем пусто — на проверку.
  assert.equal(tabOf({ overall_criticality: 'critical' }), 'critical');
  assert.equal(tabOf({ overall_criticality: 'medium' }), 'working');
  assert.equal(tabOf({ overall_criticality: 'low' }), 'low');
  assert.equal(tabOf({}), 'review');
});

test('вкладки: tabCounts согласован с filterByTab, «Все» — сумма', async () => {
  const { tabCounts, filterByTab, TAB_KEYS } = await load();
  const clusters = sampleClusters();
  const counts = tabCounts(clusters);
  assert.equal(counts.all, clusters.length);
  let sum = 0;
  for (const key of TAB_KEYS.filter((k) => k !== 'all')) {
    assert.equal(filterByTab(clusters, key).length, counts[key], `вкладка ${key}`);
    sum += counts[key];
  }
  assert.equal(sum, clusters.length, 'каждый кластер ровно на одной вкладке');
  assert.equal(filterByTab(clusters, 'all').length, clusters.length);
});

// --- Фильтрация («Только существенные») --------------------------------------

test('фильтрация: «Только существенные» = critical + high + review, ничего не удаляет', async () => {
  const { visibleClusters } = await load();
  const clusters = sampleClusters();
  const before = clusters.map((c) => c.id);

  const essential = visibleClusters(clusters, { tab: 'all', essential: true });
  assert.deepEqual(essential.map((c) => c.id), ['c1', 'c2', 'c4']);

  // Исходный массив не изменился — фильтр снимается одним действием.
  assert.deepEqual(clusters.map((c) => c.id), before);
  const off = visibleClusters(clusters, { tab: 'all', essential: false });
  assert.equal(off.length, clusters.length);

  // Фильтр сочетается с вкладкой: рабочие при essential пусты, критичные — целы.
  assert.equal(visibleClusters(clusters, { tab: 'working', essential: true }).length, 0);
  assert.equal(visibleClusters(clusters, { tab: 'critical', essential: true }).length, 2);
});

// --- Сохранение решения -------------------------------------------------------

test('сохранение решения: payload production-слоя для accept/edit/reject', async () => {
  const { productionPayloadFor } = await load();
  assert.deepEqual(productionPayloadFor('accept', { comment: 'ок' }), {
    decision: 'accept',
    final_comment: 'ок',
  });
  const edit = productionPayloadFor('edit', {
    finalText: 'Новая редакция', reasonCode: 'wrong_action', comment: '',
  });
  assert.equal(edit.decision, 'edit');
  assert.equal(edit.edited_redaction, 'Новая редакция');
  assert.deepEqual(productionPayloadFor('reject', {}), { decision: 'reject', final_comment: null });
  assert.equal(productionPayloadFor('delete', {}).decision, 'delete');
  assert.equal(productionPayloadFor('remove_from_scope', {}).decision, 'remove_from_scope');
});

test('сохранение решения: payload shadow-слоя зеркалит словарь сервера', async () => {
  const { shadowPayloadFor } = await load();
  assert.equal(shadowPayloadFor('accept', {}).decision, 'accepted');
  const edit = shadowPayloadFor('edit', { finalText: 'Текст', reasonCode: 'wrong_action' });
  assert.equal(edit.decision, 'accepted_with_edit');
  assert.equal(edit.final_text, 'Текст');
  assert.equal(edit.reason_code, 'wrong_action');
  const rej = shadowPayloadFor('reject', { reasonCode: 'duplicate', comment: 'дубль №3' });
  assert.equal(rej.decision, 'rejected');
  assert.equal(rej.reason_code, 'duplicate');
  assert.equal(shadowPayloadFor('defer', {}).decision, 'deferred');
  const merged = shadowPayloadFor('merge', {}, { mergeTargetLabel: 'Уборка и вывоз мусора' });
  assert.equal(merged.decision, 'merged');
  assert.match(merged.comment, /Уборка и вывоз мусора/);
  const prio = shadowPayloadFor('priority', { priority: 'high' }, { currentPriority: 'medium' });
  assert.equal(prio.decision, 'deferred');
  assert.equal(prio.reason_code, 'wrong_priority');
  assert.match(prio.comment, /medium → high/);
});

test('сохранение решения: decisionStateOf — production главнее shadow', async () => {
  const { decisionStateOf } = await load();
  assert.equal(decisionStateOf({}, null), null);
  assert.equal(decisionStateOf({ decision: { decision: 'accept' } }, null), 'accepted');
  assert.equal(decisionStateOf({ decision: { decision: 'edit' } }, null), 'accepted');
  assert.equal(decisionStateOf({ decision: { decision: 'reject' } }, null), 'rejected');
  assert.equal(decisionStateOf({}, { decision: 'accepted_with_edit' }), 'accepted');
  assert.equal(decisionStateOf({}, { decision: 'deferred' }), 'deferred');
  assert.equal(decisionStateOf({}, { decision: 'merged' }), 'merged');
  // Production-решение не перекрывается shadow-решением.
  assert.equal(decisionStateOf({ decision: { decision: 'accept' } }, { decision: 'rejected' }), 'accepted');
});

// --- Обязательная причина отклонения ------------------------------------------

test('причина: отклонение и правка без структурированной причины не проходят', async () => {
  const { validateDecisionForm } = await load();
  assert.equal(validateDecisionForm('reject', {}).ok, false);
  assert.equal(validateDecisionForm('reject', { reasonCode: 'no_material_impact' }).ok, true);
  assert.equal(validateDecisionForm('reject', { reasonCode: 'выдуманная' }).ok, false);
  assert.equal(
    validateDecisionForm('edit', { finalText: 'Текст' }).ok, false,
    'правка тоже требует причину',
  );
  assert.equal(
    validateDecisionForm('edit', { finalText: 'Текст', reasonCode: 'wrong_action' }).ok, true,
  );
  assert.equal(
    validateDecisionForm('edit', { reasonCode: 'wrong_action' }).ok, false,
    'правка без итогового текста не проходит',
  );
});

test('причина: комментарий обязателен только для «other»', async () => {
  const { validateDecisionForm } = await load();
  assert.equal(validateDecisionForm('reject', { reasonCode: 'other' }).ok, false);
  assert.equal(validateDecisionForm('reject', { reasonCode: 'other', comment: 'своя причина' }).ok, true);
  assert.equal(
    validateDecisionForm('reject', { reasonCode: 'duplicate' }).ok, true,
    'для остальных причин комментарий необязателен',
  );
  // Принять / на проверку — без причины и комментария.
  assert.equal(validateDecisionForm('accept', {}).ok, true);
  assert.equal(validateDecisionForm('defer', {}).ok, true);
});

// --- Навигация ----------------------------------------------------------------

test('навигация: moveIndex не выходит за границы списка', async () => {
  const { moveIndex, clampIndex } = await load();
  assert.equal(moveIndex(5, 0, 1), 1);
  assert.equal(moveIndex(5, 4, 1), 4, 'у последнего «следующее» остаётся на месте');
  assert.equal(moveIndex(5, 0, -1), 0, 'у первого «предыдущее» остаётся на месте');
  assert.equal(moveIndex(5, -1, 1), 0, 'нет выбора — стрелка выбирает первое');
  assert.equal(moveIndex(0, 0, 1), -1, 'пустой список — навигации нет');
  assert.equal(clampIndex(3, 99), 2);
});

test('навигация: nextUndecidedIndex циклически ищет необработанное', async () => {
  const { nextUndecidedIndex } = await load();
  const items = ['a', 'b', 'c', 'd'];
  const decided = new Set(['b', 'c']);
  assert.equal(nextUndecidedIndex(items, 0, (x) => decided.has(x)), 3);
  // Цикл через конец списка.
  assert.equal(nextUndecidedIndex(items, 3, (x) => decided.has(x)), 0);
  // Все обработаны — null (стоим на месте, не зацикливаемся).
  assert.equal(nextUndecidedIndex(items, 1, () => true), null);
  assert.equal(nextUndecidedIndex([], 0, () => false), null);
});

// --- Горячие клавиши ------------------------------------------------------------

test('горячие клавиши: A/E/R/V и стрелки, по физическому коду клавиши', async () => {
  const { hotkeyAction } = await load();
  assert.equal(hotkeyAction({ code: 'KeyA' }), 'accept');
  assert.equal(hotkeyAction({ code: 'KeyE' }), 'edit');
  assert.equal(hotkeyAction({ code: 'KeyR' }), 'reject');
  assert.equal(hotkeyAction({ code: 'KeyV' }), 'defer');
  assert.equal(hotkeyAction({ code: 'ArrowDown' }), 'next');
  assert.equal(hotkeyAction({ code: 'ArrowRight' }), 'next');
  assert.equal(hotkeyAction({ code: 'ArrowUp' }), 'prev');
  assert.equal(hotkeyAction({ code: 'ArrowLeft' }), 'prev');
  assert.equal(hotkeyAction({ code: 'KeyZ' }), null);
});

test('горячие клавиши: не срабатывают в полях ввода и с модификаторами', async () => {
  const { hotkeyAction } = await load();
  assert.equal(hotkeyAction({ code: 'KeyA', target: { tagName: 'TEXTAREA' } }), null);
  assert.equal(hotkeyAction({ code: 'KeyR', target: { tagName: 'input' } }), null);
  assert.equal(hotkeyAction({ code: 'KeyA', target: { isContentEditable: true } }), null);
  assert.equal(hotkeyAction({ code: 'KeyA', ctrlKey: true }), null);
  assert.equal(hotkeyAction({ code: 'KeyA', metaKey: true }), null);
  assert.equal(hotkeyAction({ code: 'KeyA', altKey: true }), null);
  assert.equal(hotkeyAction({ code: 'KeyA', target: { tagName: 'DIV' } }), 'accept');
});

// --- Цитата в документе ---------------------------------------------------------

const DOC = [
  '# Техническое задание',
  '',
  '## 3. Обязанности подрядчика',
  '',
  'Подрядчик обязан выполнять ежедневную уборку строительной площадки,',
  'а также вывоз строительного мусора за свой счёт.',
  '',
  '## 4. Оплата',
  '',
  'Оплата производится в течение 90 дней после подписания актов.',
].join('\n');

test('цитата: находится с нормализацией пробелов, ё и кавычек', async () => {
  const { locateQuote } = await load();
  // Перенос строки в документе против пробела в цитате + «ё»/«е».
  const hit = locateQuote(DOC, 'уборку строительной площадки, а также вывоз строительного мусора за свой счет');
  assert.ok(hit, 'цитата должна найтись');
  assert.equal(hit.exact, true);
  const found = DOC.slice(hit.start, hit.end);
  assert.match(found, /^уборку строительной площадки/);
  assert.match(found, /за свой счёт$/);
});

test('цитата: отсутствующая цитата — null, а не подсветка «чего-нибудь»', async () => {
  const { locateQuote } = await load();
  assert.equal(locateQuote(DOC, 'гарантийный срок составляет 10 лет'), null);
  assert.equal(locateQuote(DOC, ''), null);
  assert.equal(locateQuote('', 'что-то'), null);
});

test('цитата: длинная изменённая цитата находится по префиксу (exact:false)', async () => {
  const { locateQuote } = await load();
  const quote =
    'Оплата производится в течение 90 дней после подписания актов, при этом заказчик ' +
    'оставляет за собой право удержания десяти процентов от суммы до устранения замечаний';
  const hit = locateQuote(DOC, quote);
  assert.ok(hit, 'префикс длинной цитаты должен найтись');
  assert.equal(hit.exact, false);
  assert.match(DOC.slice(hit.start, hit.end), /^Оплата производится/);
});

test('цитата: splitDocBlocks/sectionTitleFor дают раздел для позиции', async () => {
  const { splitDocBlocks, sectionTitleFor, locateQuote } = await load();
  const blocks = splitDocBlocks(DOC);
  assert.ok(blocks.every((b) => DOC.slice(b.start, b.end) === b.text), 'смещения блоков точные');
  const hit = locateQuote(DOC, 'в течение 90 дней');
  assert.equal(sectionTitleFor(blocks, hit.start), '4. Оплата');
  const hit2 = locateQuote(DOC, 'ежедневную уборку');
  assert.equal(sectionTitleFor(blocks, hit2.start), '3. Обязанности подрядчика');
});

// --- Сохранение состояния просмотра ---------------------------------------------

test('состояние: ключ включает пользователя, тендер и прогон; roundtrip устойчив к мусору', async () => {
  const { reviewStateKey, packReviewState, unpackReviewState } = await load();
  const k1 = reviewStateKey('t1', 'run1', 'user@corp');
  const k2 = reviewStateKey('t1', 'run2', 'user@corp');
  const k3 = reviewStateKey('t1', 'run1', 'other@corp');
  assert.notEqual(k1, k2, 'другой прогон — другой ключ');
  assert.notEqual(k1, k3, 'другой пользователь — другой ключ');

  const packed = packReviewState({ tab: 'review', essential: true, selected_id: 'c42' });
  assert.deepEqual(unpackReviewState(packed), { tab: 'review', essential: true, selected_id: 'c42' });

  const fallback = { tab: 'critical', essential: false, selected_id: null };
  assert.deepEqual(unpackReviewState('не json'), fallback);
  assert.deepEqual(unpackReviewState(null), fallback);
  assert.deepEqual(unpackReviewState(JSON.stringify({ tab: 'левая', selected_id: 7 })), fallback);
});

// --- ИНВАРИАНТ SHADOW MODE -------------------------------------------------------

test('shadow: «на проверку», «объединить» и «приоритет» НЕ трогают production-слой', async () => {
  const { productionPayloadFor } = await load();
  assert.equal(productionPayloadFor('defer', {}), null);
  assert.equal(productionPayloadFor('merge', { mergeTargetId: 'x' }), null);
  assert.equal(productionPayloadFor('priority', { priority: 'low' }), null);
});

test('shadow: квалификация gate не влияет на вкладку и статус замечания', async () => {
  const { tabOf, computeStats, decisionStateOf } = await load();
  const cluster = { id: 'c1', verdict: 'publish', overall_impact_level: 'critical' };

  // Gate предлагает скрыть — вкладка и статус production-слоя не меняются.
  const gate = new Map([['c1', { qualification: 'reject' }]]);
  assert.equal(tabOf(cluster), 'critical');
  assert.equal(decisionStateOf(cluster, null), null, 'gate-оценка ≠ решение инженера');

  const stats = computeStats([cluster], new Map(), gate);
  assert.equal(stats.gate_hidden, 1, 'рекомендация видна в статистике…');
  assert.equal(stats.undecided, 1, '…но замечание остаётся необработанным');
  assert.equal(stats.critical, 1, '…и остаётся на вкладке критичных');
});

test('shadow: shadow-решение инженера не мутирует кластер', async () => {
  const { computeStats, decisionStateOf } = await load();
  const cluster = { id: 'c1', verdict: 'publish', overall_impact_level: 'high', decision: null };
  const frozen = JSON.stringify(cluster);
  const shadow = new Map([['c1', { decision: 'rejected', reason_code: 'duplicate' }]]);

  const state = decisionStateOf(cluster, shadow.get('c1'));
  assert.equal(state, 'rejected', 'локальный статус страницы отражает shadow-решение…');
  computeStats([cluster], shadow, new Map());
  assert.equal(JSON.stringify(cluster), frozen, '…но сам кластер (production-снимок) не изменён');
  assert.equal(cluster.decision, null, 'production-решения по-прежнему нет');
});
