'use strict';

// Юнит-тесты cluster-level выгрузок (этап 7) — без БД и LLM.
// Чистое ядро exportService (CSV/summary от кластеров) и reviewHtmlService
// (локализация фрагмента + аннотация кластера для preview). Запуск: npm test.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  CLUSTER_CSV_HEADERS,
  clusterReviewStatus,
  clusterCsvRow,
  clustersToCsv,
  clusterSummaryStats,
} = require('../../services/exportService');

const {
  locateFragment,
  clusterToAnnotation,
  issueToAnnotation,
} = require('../../services/reviewHtmlService');

const { humanizeNoteText } = require('../../services/review/noteText');

// --- Фабрики фикстур ----------------------------------------------------------

function cluster(extra = {}) {
  return {
    id: 'cl1',
    tz_clause: '3.2 Объём работ',
    cluster_title: 'Открытый объём работ',
    final_problem_type: 'открытый_объём',
    overall_criticality: 'high',
    item_count: 2,
    merged_basis: 'Объём не ограничен; риск доп. работ без оплаты.',
    merged_recommendation: 'Зафиксировать перечень работ приложением.',
    paragraph_index: 4,
    ...extra,
  };
}

function primary(extra = {}) {
  return {
    id: 'd1',
    tz_clause: '3.2',
    problem_type: 'открытый_объём',
    source_fragment: 'Подрядчик выполняет все работы, необходимые Заказчику.',
    basis: 'Формулировка «все работы» не ограничена.',
    suggested_action: 'replace',
    suggested_redaction: 'Подрядчик выполняет работы согласно Приложению 1.',
    paragraph_index: 4,
    ...extra,
  };
}

function decision(extra = {}) {
  return {
    decision: 'edit',
    edited_redaction: null,
    final_comment: 'Согласовано с юристом.',
    target_text: null,
    decided_at: '2026-06-10T12:00:00.000Z',
    ...extra,
  };
}

// --- clusterReviewStatus --------------------------------------------------------

test('clusterReviewStatus: нет решения -> pending, reject -> rejected, иначе decided', () => {
  assert.equal(clusterReviewStatus(null), 'pending');
  assert.equal(clusterReviewStatus(decision({ decision: 'reject' })), 'rejected');
  assert.equal(clusterReviewStatus(decision({ decision: 'edit' })), 'decided');
  assert.equal(clusterReviewStatus(decision({ decision: 'remove_from_scope' })), 'decided');
});

// --- CSV ------------------------------------------------------------------------

test('clusterCsvRow: маппинг полей кластера + фолбэки на primary draft', () => {
  const row = clusterCsvRow({ cluster: cluster(), primary: primary(), decision: decision() });
  assert.equal(row.cluster_id, 'cl1');
  assert.equal(row.tz_clause, '3.2 Объём работ');
  assert.equal(row.source_fragment, 'Подрядчик выполняет все работы, необходимые Заказчику.');
  assert.equal(row.suggested_redaction, 'Подрядчик выполняет работы согласно Приложению 1.');
  assert.equal(row.decision, 'edit');
  assert.equal(row.review_status, 'decided');
  // без tz_clause у кластера — берётся из primary
  const row2 = clusterCsvRow({ cluster: cluster({ tz_clause: null }), primary: primary(), decision: null });
  assert.equal(row2.tz_clause, '3.2');
  assert.equal(row2.review_status, 'pending');
  assert.equal(row2.decision, '');
});

test('clustersToCsv: BOM + заголовок + по строке на кластер, ; экранируется', () => {
  const rows = [
    { cluster: cluster(), primary: primary(), decision: decision() },
    { cluster: cluster({ id: 'cl2', cluster_title: 'Оплата; отсрочка 90 дней' }), primary: null, decision: null },
  ];
  const csv = clustersToCsv(rows);
  assert.ok(csv.startsWith('﻿')); // UTF-8 BOM для Excel
  const lines = csv.slice(1).split('\r\n');
  assert.equal(lines[0], CLUSTER_CSV_HEADERS.join(';'));
  assert.equal(lines.length, 3);
  assert.ok(lines[2].includes('"Оплата; отсрочка 90 дней"'));
});

// --- summary stats ----------------------------------------------------------------

test('clusterSummaryStats: счётчики решений, критичности и сведённых находок', () => {
  const rows = [
    { cluster: cluster({ item_count: 2 }), primary: primary(), decision: decision() },
    { cluster: cluster({ id: 'cl2', overall_criticality: 'critical', item_count: 3 }), primary: null, decision: decision({ decision: 'delete' }) },
    { cluster: cluster({ id: 'cl3', overall_criticality: 'low', item_count: 1 }), primary: null, decision: decision({ decision: 'reject' }) },
    { cluster: cluster({ id: 'cl4', overall_criticality: 'medium', item_count: 1 }), primary: null, decision: null },
  ];
  const s = clusterSummaryStats(rows);
  assert.equal(s.clusters, 4);
  assert.equal(s.draft_issues, 7);
  assert.equal(s.decided, 2);
  assert.equal(s.rejected, 1);
  assert.equal(s.pending, 1);
  assert.deepEqual(s.by_decision, { edit: 1, delete: 1, reject: 1 });
  assert.equal(s.by_criticality.high, 1);
  assert.equal(s.by_criticality.critical, 1);
  assert.equal(s.important, 2); // critical + high
});

// --- locateFragment -----------------------------------------------------------------

const BLOCKS = [
  { index: 0, text: 'Раздел 1. Общие положения.' },
  { index: 4, text: 'Пункт 3.2. Подрядчик выполняет все работы, необходимые Заказчику.' },
  { index: 7, text: 'Оплата производится после подписания акта.' },
];

test('locateFragment: находит фрагмент в подсказанном абзаце с char-диапазоном', () => {
  const frag = 'Подрядчик выполняет все работы, необходимые Заказчику.';
  const loc = locateFragment(BLOCKS, 4, frag);
  assert.equal(loc.paragraph_index, 4);
  assert.equal(loc.char_start, BLOCKS[1].text.indexOf(frag));
  assert.equal(loc.char_end, loc.char_start + frag.length);
});

test('locateFragment: неверная подсказка -> поиск по всем абзацам', () => {
  const loc = locateFragment(BLOCKS, 0, 'Оплата производится после подписания акта.');
  assert.equal(loc.paragraph_index, 7);
});

test('locateFragment: фрагмента нет в тексте или он пуст -> null', () => {
  assert.equal(locateFragment(BLOCKS, 4, 'Такого текста в ТЗ нет.'), null);
  assert.equal(locateFragment(BLOCKS, 4, ''), null);
  assert.equal(locateFragment(BLOCKS, 4, null), null);
});

// --- clusterToAnnotation -------------------------------------------------------------

test('annotation: решение edit -> вид replace, редакция инженера приоритетнее primary', () => {
  const loc = { paragraph_index: 4, char_start: 12, char_end: 20 };
  const a = clusterToAnnotation(cluster(), primary(), decision({ edited_redaction: 'Текст инженера.' }), loc);
  assert.equal(a.visual.mark, 'replace');
  assert.equal(a.redaction, 'Текст инженера.');
  assert.equal(a.paragraph_index, 4);
  assert.equal(a.badge, 'К×2');
  // без редакции инженера — suggested_redaction primary
  const b = clusterToAnnotation(cluster(), primary(), decision(), loc);
  assert.equal(b.redaction, 'Подрядчик выполняет работы согласно Приложению 1.');
});

test('annotation: без решения -> pending «на рассмотрении», комментарий из рекомендации', () => {
  const a = clusterToAnnotation(cluster({ item_count: 1 }), primary(), null, null);
  assert.equal(a.visual.mark, 'pending');
  assert.equal(a.visual.label, 'на рассмотрении');
  assert.equal(a.comment, 'Зафиксировать перечень работ приложением.');
  assert.equal(a.badge, 'К');
  assert.equal(a.paragraph_index, null); // не локализован — уйдёт в «вне текста»
});

test('annotation: remove_from_scope несёт тег «Вынесено из объёма» (как в docx/md)', () => {
  const a = clusterToAnnotation(cluster(), primary(), decision({ decision: 'remove_from_scope' }), null);
  assert.equal(a.visual.mark, 'strike');
  assert.equal(a.visual.tag, 'Вынесено из объёма ГП');
});

// --- humanizeNoteText (служебный токен in_calc не должен утечь в выгрузки) -----

test('humanizeNoteText: in_calc=0/1/null -> человеческий русский', () => {
  assert.equal(
    humanizeNoteText('in_calc=0 по чек-листу. Раздел отсутствует в ВОР.'),
    'не входит в объём ГП по чек-листу. Раздел отсутствует в ВОР.',
  );
  assert.equal(
    humanizeNoteText('Позиция №28 — in_calc=0.'),
    'Позиция №28 — не входит в объём ГП.',
  );
  assert.equal(humanizeNoteText('Работа есть, in_calc = 1.'), 'Работа есть, входит в объём ГП.');
  assert.equal(humanizeNoteText('in_calc=null'), 'статус не определён');
  // вариант без знака равенства: «in_calc не определён» (агент пишет словами)
  assert.equal(
    humanizeNoteText('Позиция «Автополив» отсутствует (in_calc не определён).'),
    'Позиция «Автополив» отсутствует (статус не определён).',
  );
  // нет токена / пусто — без изменений
  assert.equal(humanizeNoteText('Обычное замечание.'), 'Обычное замечание.');
  assert.equal(humanizeNoteText(null), null);
  assert.equal(humanizeNoteText(''), '');
});

test('annotation (legacy issue): бейдж = номер стадии, pending без решения', () => {
  const a = issueToAnnotation({
    id: 'i1', analysis_stage: 3, problem_type: 'условие_противоречит',
    criticality: 'high', review_status: 'pending', decision_kind: null,
    paragraph_index: 2, char_start: 0, char_end: 10,
  });
  assert.equal(a.badge, '3');
  assert.equal(a.visual.mark, 'pending');
  assert.ok(a.title.includes('Стадия 3'));
});
