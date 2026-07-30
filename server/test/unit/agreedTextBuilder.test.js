'use strict';

// Юнит-тесты билдера согласованной версии ТЗ (agreedTextBuilder) — без БД и LLM.
// Проверяют: delete целиком/подчасти, edit с заменой, remove_from_scope,
// несколько вхождений одного кластера, два решения в одном абзаце (регресс
// дрейфа координат старого finishStage), «не найден» → failed при целом тексте,
// сохранность md-разметки (заголовок/таблица/список), конфликт пересечения.
// Запуск: npm run test:unit.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildAgreedText, findTolerant, uniqueOccurrences } = require('../../services/agreedVersion/agreedTextBuilder');
const { parseMdToBlocks } = require('../../services/mdParser');

const MD = `# 1. Объём работ

Подрядчик выполняет ежедневную уборку строительной площадки и вывоз мусора за свой счёт.

Гарантийный срок составляет 10 лет с момента подписания акта.

# 2. Оплата

Оплата производится в течение 90 банковских дней после подписания акта.

| Работа | Объём |
| --- | --- |
| Монтаж каркаса | 120 т |
| Уборка территории | ежедневно |

- Подрядчик обеспечивает охрану объекта.
- Подрядчик оформляет исполнительную документацию.
`;

async function build(decisions, md = MD) {
  const blocks = await parseMdToBlocks(md);
  return buildAgreedText({ rawMd: md, blocks, decisions });
}

function decision(over = {}) {
  return {
    cluster_id: over.cluster_id || 'cl-1',
    decision: 'delete',
    target_text: null,
    edited_redaction: null,
    suggested_redaction: null,
    representative_fragment: null,
    paragraph_index: null,
    evidence_fragments: [],
    ...over,
  };
}

test('delete: фрагмент-подстрока вырезается, остальной абзац цел', async () => {
  const { mdText, report } = await build([decision({
    representative_fragment: 'и вывоз мусора за свой счёт',
  })]);
  assert.equal(report.applied, 1);
  assert.ok(!mdText.includes('вывоз мусора'));
  assert.ok(mdText.includes('Подрядчик выполняет ежедневную уборку строительной площадки'));
});

test('delete подчасти через target_text: вырезается ровно подчасть', async () => {
  const { mdText, report } = await build([decision({
    representative_fragment: 'Гарантийный срок составляет 10 лет с момента подписания акта.',
    target_text: '10 лет',
  })]);
  assert.equal(report.applied, 1);
  assert.ok(!mdText.includes('10 лет'));
  assert.ok(mdText.includes('Гарантийный срок составляет'), 'остальной текст пункта не тронут');
});

test('delete целого абзаца забирает и переводы строк (нет пустой дыры)', async () => {
  const frag = 'Гарантийный срок составляет 10 лет с момента подписания акта.';
  const { mdText, report } = await build([decision({ representative_fragment: frag })]);
  assert.equal(report.applied, 1);
  assert.ok(!mdText.includes('Гарантийный срок'));
  assert.ok(!mdText.includes('\n\n\n'), 'тройных переводов строк после вырезания нет');
});

test('edit: замена текста через edited_redaction', async () => {
  const { mdText, report } = await build([decision({
    decision: 'edit',
    representative_fragment: 'Оплата производится в течение 90 банковских дней после подписания акта.',
    edited_redaction: 'Оплата производится в течение 30 календарных дней после подписания акта.',
  })]);
  assert.equal(report.applied, 1);
  assert.ok(mdText.includes('30 календарных дней'));
  assert.ok(!mdText.includes('90 банковских дней'));
});

test('edit без текста замены → failed, текст цел', async () => {
  const { mdText, report } = await build([decision({
    decision: 'edit',
    representative_fragment: 'Оплата производится в течение 90 банковских дней после подписания акта.',
  })]);
  assert.equal(report.failed, 1);
  assert.equal(report.applied, 0);
  assert.ok(mdText.includes('90 банковских дней'));
});

test('remove_from_scope: несколько вхождений — вырезаются ВСЕ', async () => {
  const { mdText, report } = await build([decision({
    decision: 'remove_from_scope',
    representative_fragment: 'ежедневную уборку строительной площадки',
    paragraph_index: 1,
    evidence_fragments: [
      { paragraph_index: 1, fragment: 'ежедневную уборку строительной площадки' },
      { paragraph_index: 7, fragment: 'Уборка территории | ежедневно' },
    ],
  })]);
  assert.equal(report.applied, 2, 'оба вхождения применены');
  assert.ok(!mdText.includes('уборку строительной площадки'));
  assert.ok(!mdText.includes('Уборка территории'));
});

test('md-разметка сохраняется: заголовки, таблица и список не деградируют', async () => {
  const { mdText } = await build([decision({
    representative_fragment: 'и вывоз мусора за свой счёт',
  })]);
  assert.ok(mdText.includes('# 1. Объём работ'), 'заголовок с # цел');
  assert.ok(mdText.includes('| Монтаж каркаса | 120 т |'), 'таблица цела');
  assert.ok(mdText.includes('- Подрядчик обеспечивает охрану объекта.'), 'список цел');
});

test('РЕГРЕСС дрейфа координат: два решения в одном абзаце применяются точно', async () => {
  // Старый finishStage локализовал второе исключение по УРЕЗАННОМУ тексту —
  // координаты съезжали. Билдер собирает операции по сырой строке и применяет
  // справа налево: обе правки ложатся дословно.
  const { mdText, report } = await build([
    decision({ cluster_id: 'cl-a', representative_fragment: 'ежедневную уборку строительной площадки' }),
    decision({ cluster_id: 'cl-b', representative_fragment: 'за свой счёт' }),
  ]);
  assert.equal(report.applied, 2);
  assert.ok(!mdText.includes('ежедневную уборку строительной площадки'));
  assert.ok(!mdText.includes('за свой счёт'));
  assert.ok(mdText.includes('и вывоз мусора'), 'непомеченный текст абзаца сохранён');
});

test('конфликт: пересекающиеся операции — выигрывает первое решение', async () => {
  const { mdText, report } = await build([
    decision({ cluster_id: 'cl-first', representative_fragment: 'ежедневную уборку строительной площадки и вывоз мусора' }),
    decision({ cluster_id: 'cl-second', decision: 'edit',
      representative_fragment: 'вывоз мусора за свой счёт',
      edited_redaction: 'вывоз мусора силами заказчика' }),
  ]);
  assert.equal(report.applied, 1);
  assert.equal(report.conflicts, 1);
  assert.ok(!mdText.includes('ежедневную уборку'));
  assert.ok(!mdText.includes('силами заказчика'), 'конфликтующая правка не применена');
});

test('фрагмент не найден → failed, текст не изменён', async () => {
  const { mdText, report } = await build([decision({
    representative_fragment: 'Такого текста в ТЗ нет вообще.',
  })]);
  assert.equal(report.failed, 1);
  assert.equal(mdText, MD);
});

test('edit не-representative вхождения: без дословного совпадения → skipped_occurrence', async () => {
  const { mdText, report } = await build([decision({
    decision: 'edit',
    representative_fragment: 'Подрядчик обеспечивает охрану объекта.',
    edited_redaction: 'Охрану объекта обеспечивает заказчик.',
    evidence_fragments: [
      { paragraph_index: 10, fragment: 'Подрядчик обеспечивает охрану объекта.' },
      // Другая формулировка той же обязанности — дословной цели здесь нет.
      { paragraph_index: 1, fragment: 'ежедневную уборку строительной площадки' },
    ],
  })]);
  assert.equal(report.applied, 1, 'representative заменён');
  assert.equal(report.skipped, 1, 'вхождение с другой формулировкой пропущено');
  assert.ok(mdText.includes('Охрану объекта обеспечивает заказчик.'));
  assert.ok(mdText.includes('ежедневную уборку строительной площадки'), 'чужая формулировка не тронута');
});

test('accept и reject не меняют текст (noop)', async () => {
  const { mdText, report } = await build([
    decision({ decision: 'accept', representative_fragment: 'за свой счёт' }),
    decision({ decision: 'reject', representative_fragment: '90 банковских дней' }),
  ]);
  assert.equal(report.noop, 2);
  assert.equal(mdText, MD);
});

test('tolerant-поиск: отличие в пробелах/переводах строк не мешает', async () => {
  const hit = findTolerant('Оплата производится в течение\n90   банковских дней.', 'в течение 90 банковских дней');
  assert.ok(hit);
});

test('uniqueOccurrences: дубли мест схлопываются, representative добавляется', () => {
  const occ = uniqueOccurrences({
    representative_fragment: 'Фрагмент А',
    paragraph_index: 3,
    evidence_fragments: [
      { paragraph_index: 5, fragment: 'Фрагмент Б' },
      { paragraph_index: 5, fragment: 'Фрагмент  Б' }, // дубль с лишним пробелом
    ],
  });
  assert.equal(occ.length, 2);
  assert.equal(occ[0].fragment, 'Фрагмент А', 'representative — первым');
});

test('цепочка версий: повторный build поверх результата первого', async () => {
  const first = await build([decision({ representative_fragment: 'и вывоз мусора за свой счёт' })]);
  const second = await build(
    [decision({ cluster_id: 'cl-2', decision: 'edit',
      representative_fragment: 'Гарантийный срок составляет 10 лет с момента подписания акта.',
      edited_redaction: 'Гарантийный срок составляет 5 лет с момента подписания акта.' })],
    first.mdText,
  );
  assert.equal(second.report.applied, 1);
  assert.ok(!second.mdText.includes('вывоз мусора'), 'правка первой версии сохранена');
  assert.ok(second.mdText.includes('5 лет'), 'правка второй версии применена');
});

// --- Снимок решений → строки экспорта (agreedVersionService, чистая) -----------

const { snapshotToExportRows } = require('../../services/agreedVersion/agreedVersionService');

test('snapshotToExportRows: формат совпадает с loadClusterDecisions, reject отброшен', () => {
  const rows = snapshotToExportRows([
    {
      cluster_id: 'c1', decision: 'delete', representative_fragment: 'фрагмент',
      tz_clause: 'п. 1.1', paragraph_index: 3, problem_type: 'не_учтено_в_кп',
      final_comment: 'вне объёма', target_text: null, edited_redaction: null, suggested_redaction: null,
    },
    { cluster_id: 'c2', decision: 'reject', representative_fragment: 'х' },
    {
      cluster_id: 'c3', decision: 'edit', representative_fragment: 'старый текст',
      edited_redaction: null, suggested_redaction: 'новый текст',
    },
  ]);
  assert.equal(rows.length, 2, 'reject не экспортируется');
  assert.equal(rows[0].decision_kind, 'delete');
  assert.equal(rows[0].issue.source_fragment, 'фрагмент');
  assert.equal(rows[0].issue.source_clause, 'п. 1.1');
  assert.equal(rows[0].issue.paragraph_index, 3);
  assert.equal(rows[0].final_comment, 'вне объёма');
  assert.equal(rows[1].edited_redaction, 'новый текст', 'edit без правки инженера берёт suggested_redaction');
});
