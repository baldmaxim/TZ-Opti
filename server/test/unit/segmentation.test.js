'use strict';

// Иерархическая token-aware сегментация больших ТЗ (shared/segmentation.js),
// прогон стадии по частям (shared/llmStage.js) и финальная межраздельная сверка
// (shared/crossSegmentReview.js) — без БД и без сети (LLM подменён fakeLlm).
//
// Ключевой сценарий: БОЛЬШОЕ синтетическое ТЗ + риск НА ГРАНИЦЕ двух сегментов
// (проблема видна, только если два соседних пункта прочитаны вместе). Без
// перекрытия такой риск теряется — тест это фиксирует явно.
// Запуск: npm run test:unit.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  estimateTokens,
  segmentDocument,
  splitOversizedBlock,
  renderSegmentText,
  isClauseStart,
} = require('../../services/stageAnalysis/shared/segmentation');
const { runLlmStage } = require('../../services/stageAnalysis/shared/llmStage');
const {
  dedupeAcrossSegments,
  applyReconciliation,
} = require('../../services/stageAnalysis/shared/crossSegmentReview');
const { runStage2Llm } = require('../../services/stageAnalysis/stage2_llm');
const { segmentsForQc } = require('../../services/stageAnalysis/stage5_llm');
const { installFakeLlm } = require('../helpers/fakeLlm');

// --- Синтетическое ТЗ ----------------------------------------------------------

const FILLER = [
  'Подрядчик выполняет работы в объёме, определённом проектной документацией и',
  'настоящим техническим заданием, с соблюдением требований действующих норм,',
  'правил охраны труда и промышленной безопасности, а также графика производства работ.',
].join(' ');

// Большое ТЗ: разделы (заголовки уровня 1) → подразделы (уровень 2) → пункты
// вида «3.4.1 …». Пункты короткие (как в реальном ТЗ), чтобы перекрытие брало
// ЦЕЛЫЕ пункты, а не хвостовой срез.
function buildBigTz({ sections = 26, subsections = 4, clauses = 9, fill = 4 } = {}) {
  const blocks = [];
  let index = 0;
  const push = (b) => { blocks.push({ index: index++, ...b }); };
  for (let s = 1; s <= sections; s += 1) {
    const sTitle = `${s}. Раздел ${s}. Требования к производству работ`;
    push({ type: 'heading', level: 1, text: sTitle, section_path: [] });
    for (let ss = 1; ss <= subsections; ss += 1) {
      const ssTitle = `${s}.${ss} Подраздел ${s}.${ss}`;
      push({ type: 'heading', level: 2, text: ssTitle, section_path: [sTitle] });
      for (let c = 1; c <= clauses; c += 1) {
        push({
          type: 'paragraph',
          text: `${s}.${ss}.${c} ${FILLER} ${`Пункт ${s}.${ss}.${c} уточняет порядок выполнения соответствующего вида работ. `.repeat(fill)}`.trim(),
          section_path: [sTitle, ssTitle],
        });
      }
    }
  }
  return blocks;
}

const totalChars = (blocks) => blocks.reduce((n, b) => n + b.text.length, 0);

// Промт стадии-пустышки: ровно то, что делает настоящая стадия, — рендер части
// с заголовочным контекстом + пометка «часть k/n».
function testStageCfg(extra = {}) {
  return {
    sourceDocumentId: 'doc-1',
    systemMsg: 'system',
    schema: { type: 'object' },
    schemaName: 'stage_test_findings',
    tzBudget: 400_000,
    logTag: 'test',
    buildUserMessage: (segment, partIdx, partTotal) =>
      [`## ТЗ — часть ${partIdx}/${partTotal}`, '', renderSegmentText(segment)].join('\n'),
    ...extra,
  };
}

// --- Оценка токенов ------------------------------------------------------------

test('estimateTokens: кириллица дороже латиницы, оценка монотонна', () => {
  const ru = 'Подрядчик обязан выполнить работы';
  const en = 'The contractor shall perform works';
  assert.ok(estimateTokens(ru) > estimateTokens(en), 'русский текст оценивается дороже латиницы');
  assert.ok(estimateTokens(ru.repeat(10)) > estimateTokens(ru));
  assert.equal(estimateTokens(''), 0);
});

test('isClauseStart: нумерованный пункт начинает новый блок анализа, строка таблицы — нет', () => {
  assert.equal(isClauseStart({ type: 'paragraph', text: '3.4.1 Подрядчик обязан…' }), true);
  assert.equal(isClauseStart({ type: 'paragraph', text: 'а) вывоз мусора' }), true);
  assert.equal(isClauseStart({ type: 'paragraph', text: '— демонтаж перегородок' }), true);
  assert.equal(isClauseStart({ type: 'paragraph', text: 'Продолжение того же пункта.' }), false);
  assert.equal(isClauseStart({ type: 'table_row', text: '1 | Работа | м2' }), false);
  assert.equal(isClauseStart({ type: 'heading', level: 2, text: '3.4 Отделка' }), false);
});

// --- Инварианты нарезки --------------------------------------------------------

test('большое ТЗ режется на части: бюджет соблюдён, заголовочный контекст и перекрытие есть', () => {
  const blocks = buildBigTz();
  const chars = totalChars(blocks);
  assert.ok(chars > 400_000, `синтетическое ТЗ должно быть большим, получено ${chars} симв`);

  const budgetTokens = 6000;
  const { segments, stats } = segmentDocument(blocks, { budgetTokens });

  assert.ok(segments.length > 10, `ожидали много частей, получено ${segments.length}`);
  assert.equal(stats.segments, segments.length);

  for (const s of segments) {
    assert.ok(s.tokens <= budgetTokens, `часть ${s.index}: ${s.tokens} токенов > бюджета ${budgetTokens}`);
    assert.ok(s.contentBlocks.length > 0, `часть ${s.index} пуста`);
    // Заголовочный контекст сохранён: путь разделов известен для каждой части.
    assert.ok(s.headingPath.length > 0, `часть ${s.index} без заголовочного контекста`);
    const rendered = renderSegmentText(s, { total: segments.length });
    assert.ok(rendered.includes('Контекст раздела:'), `часть ${s.index}: контекст не попал в промт`);
    if (s.index > 0) {
      assert.ok(s.overlapBlocks.length > 0, `часть ${s.index} без перекрытия с предыдущей`);
      assert.ok(rendered.includes('повтор конца предыдущей части'));
    }
  }
});

test('нарезка покрывает документ целиком и без потерь: каждый блок ровно в одной части', () => {
  const blocks = buildBigTz({ sections: 8 });
  const { segments } = segmentDocument(blocks, { budgetTokens: 5000 });

  const seen = [];
  for (const s of segments) {
    for (const b of s.contentBlocks) seen.push(b.index);
  }
  const uniq = [...new Set(seen)];
  assert.equal(uniq.length, blocks.length, 'часть блоков ТЗ не попала ни в один сегмент');
  assert.deepEqual(uniq, blocks.map((b) => b.index), 'порядок блоков в нарезке нарушен');
  // Ровно один раз (перекрытие живёт отдельно, в overlapBlocks).
  assert.equal(seen.length, blocks.length, 'блок попал в контент двух частей — двойной счёт');
});

test('слишком большой отдельный блок дробится с перекрытием и покрывает весь текст', () => {
  const long = `1.1 ${'Гарантийный срок на выполненные работы составляет шестьдесят месяцев с даты подписания акта. '.repeat(1200)}`;
  const parts = splitOversizedBlock(
    { index: 5, type: 'paragraph', text: long, section_path: ['1. Гарантия'] },
    { budgetTokens: 2000, overlapTokens: 150 },
  );

  assert.ok(parts.length > 5, `ожидали дробление, получено частей: ${parts.length}`);
  for (const p of parts) {
    assert.equal(p.index, 5, 'paragraph_index частей должен остаться исходным (иначе сломается локализация)');
    assert.ok(estimateTokens(p.text) <= 2000, 'часть блока не влезла в бюджет');
    assert.ok(long.includes(p.text), 'часть блока должна быть дословной подстрокой оригинала');
  }
  // Непрерывное покрытие: следующая часть начинается не позже конца предыдущей.
  let covered = 0;
  for (const p of parts) {
    assert.ok(p.part.char_offset <= covered, `разрыв покрытия на смещении ${p.part.char_offset} (покрыто ${covered})`);
    covered = Math.max(covered, p.part.char_offset + p.text.length);
  }
  assert.equal(covered, long.length, 'дробление потеряло хвост блока');

  // Вырожденный вход: сплошной текст без пробелов и точек (склеенная таблица) —
  // границу слова искать негде, но терять текст всё равно нельзя.
  const noSpaces = 'А'.repeat(120_000);
  const solid = splitOversizedBlock(
    { index: 7, type: 'paragraph', text: noSpaces, section_path: [] },
    { budgetTokens: 2000, overlapTokens: 150 },
  );
  assert.ok(solid.length > 5, 'сплошной блок обязан дробиться');
  let solidCovered = 0;
  for (const p of solid) {
    assert.ok(p.part.char_offset <= solidCovered, 'разрыв покрытия на сплошном тексте');
    solidCovered = Math.max(solidCovered, p.part.char_offset + p.text.length);
  }
  assert.equal(solidCovered, noSpaces.length, 'сплошной блок потерял текст при дроблении');

  // И тот же блок внутри полной нарезки — все части в пределах бюджета.
  const { segments, stats } = segmentDocument(
    [{ index: 0, type: 'heading', level: 1, text: '1. Гарантия', section_path: [] },
      { index: 1, type: 'paragraph', text: long, section_path: ['1. Гарантия'] }],
    { budgetTokens: 2000 },
  );
  assert.equal(stats.splitBlocks, 1);
  assert.ok(segments.every((s) => s.tokens <= 2000), 'после дробления часть всё ещё превышает бюджет');
});

// --- Риск на границе двух сегментов --------------------------------------------

// Берём РЕАЛЬНЫЙ стык нарезки: последний пункт части k и первый пункт части k+1.
function boundaryPair(segments, k) {
  const left = segments[k].contentBlocks[segments[k].contentBlocks.length - 1];
  const right = segments[k + 1].contentBlocks.find((b) => b.type !== 'heading');
  return { left, right };
}

test('риск на стыке частей: перекрытие даёт часть, где оба пункта видны вместе', () => {
  const blocks = buildBigTz({ sections: 10 });
  const budgetTokens = 6000;
  const { segments } = segmentDocument(blocks, { budgetTokens });
  const k = Math.floor(segments.length / 2);
  const { left, right } = boundaryPair(segments, k);
  assert.ok(left && right, 'не удалось найти стык частей');

  const sees = (blocksOfSeg, text) => blocksOfSeg.some((b) => b.text.includes(text));

  // Контроль: по СОДЕРЖАНИЮ пункты разведены по разным частям — ни одна часть
  // не содержит оба (без перекрытия риск на этом стыке был бы потерян).
  const togetherByContent = segments.filter(
    (s) => sees(s.contentBlocks, left.text) && sees(s.contentBlocks, right.text),
  );
  assert.equal(togetherByContent.length, 0, 'стык выбран неверно: пункты и так в одной части');

  // А с перекрытием — часть k+1 видит оба.
  const together = segments.filter((s) => sees(s.blocks, left.text) && sees(s.blocks, right.text));
  assert.ok(
    together.length >= 1,
    'пункты со стыка не встретились вместе ни в одной части — риск на границе был бы потерян',
  );
  assert.ok(together.some((s) => s.index === k + 1), 'ожидали, что стык сшивает следующая часть');
});

test('стадия по частям находит риск на границе двух сегментов и не дублирует его', async (t) => {
  const blocks = buildBigTz({ sections: 10 });
  const budgetTokens = 6000;
  const { segments } = segmentDocument(blocks, { budgetTokens });
  const k = Math.floor(segments.length / 2);
  const { left, right } = boundaryPair(segments, k);

  // Модель, которой нужны ОБА пункта сразу: пока в части виден только один из
  // них — находки нет. Так ведёт себя реальный риск «объём в одном пункте,
  // оплата/исключение — в соседнем».
  const seenParts = [];
  const llm = installFakeLlm(t, (call) => {
    if (call.schemaName === 'cross_segment_reconciliation') {
      return { duplicates: [], cross_section: [] };
    }
    const hasLeft = call.user.includes(left.text);
    const hasRight = call.user.includes(right.text);
    seenParts.push({ hasLeft, hasRight });
    if (!(hasLeft && hasRight)) return { findings: [] };
    return {
      findings: [{
        fragment: left.text,
        section_path: (left.section_path || []).join(' › '),
        problem_type: 'типовой_риск',
        criticality: 'high',
        suggested_action: 'clarify',
        basis: 'Пункт и его продолжение в соседнем разделе вместе дают неоплачиваемый объём.',
        confidence: 0.8,
      }],
    };
  });

  const issues = await runLlmStage(
    { blocks, sourceDocumentId: 'doc-1' },
    testStageCfg({ segmentTokens: budgetTokens, issueDefaults: { suggestedAction: 'clarify', confidence: 0.7 } }),
  );

  // ТЗ ушло в модель частями, а не одним куском.
  const stageCalls = llm.calls.filter((c) => c.schemaName === 'stage_test_findings');
  assert.equal(stageCalls.length, segments.length);
  assert.ok(
    stageCalls.every((c) => /## ТЗ — часть \d+\/\d+/.test(c.user) && c.user.includes('Контекст раздела:')),
    'каждая часть должна уходить в модель с номером части и заголовочным контекстом',
  );
  assert.ok(stageCalls.length > 5, 'большое ТЗ должно разойтись на много частей');
  assert.ok(seenParts.some((p) => p.hasLeft && p.hasRight), 'ни одна часть не увидела оба пункта стыка');

  // Риск найден ровно один раз и привязан к нужному абзацу ТЗ.
  assert.equal(issues.length, 1, `ожидали одну находку, получено ${issues.length}`);
  assert.equal(issues[0].paragraph_index, left.index);
  assert.equal(issues[0].criticality, 'high');
  assert.equal(issues[0].source_fragment, left.text);
  assert.ok(issues.segmentation && issues.segmentation.segments === segments.length);
});

test('дубли со стыка (одна находка из двух соседних частей) схлопываются в одну', async (t) => {
  const blocks = buildBigTz({ sections: 6 });
  const budgetTokens = 5000;
  const { segments } = segmentDocument(blocks, { budgetTokens });
  const k = Math.floor(segments.length / 2);
  const { left } = boundaryPair(segments, k);

  installFakeLlm(t, (call) => {
    if (call.schemaName === 'cross_segment_reconciliation') {
      return { duplicates: [], cross_section: [] };
    }
    if (!call.user.includes(left.text)) return { findings: [] };
    // Пункт виден и как содержание части k, и как перекрытие части k+1 —
    // модель честно возвращает находку в обеих (в одной целиком, в другой куском).
    return {
      findings: [{
        fragment: left.text,
        problem_type: 'типовой_риск',
        criticality: 'medium',
        basis: 'Дубль со стыка частей.',
        confidence: 0.7,
      }],
    };
  });

  const issues = await runLlmStage(
    { blocks, sourceDocumentId: 'doc-1' },
    testStageCfg({ segmentTokens: budgetTokens }),
  );
  assert.equal(issues.length, 1, 'находка со стыка должна остаться одна после межраздельной сверки');
  assert.equal(issues.segmentation.reconciliation.mergedExact, 1);
});

// --- Стадии 2/3: «весь ТЗ в одном контексте» больше не требуется ---------------

test('Стадия 2 работает по частям: справочники повторяются в каждой части, ошибки нет', async (t) => {
  const blocks = buildBigTz({ sections: 14 });
  assert.ok(totalChars(blocks) > 200_000, `нужно большое ТЗ, получено ${totalChars(blocks)} симв`);

  const llm = installFakeLlm(t, (call) => {
    if (call.schemaName === 'cross_segment_reconciliation') {
      return { duplicates: [], cross_section: [] };
    }
    assert.equal(call.schemaName, 'stage2_findings');
    return { findings: [] };
  });

  const issues = await runStage2Llm({
    blocks,
    sourceDocumentId: 'doc-1',
    qaEntries: [{
      order_idx: 0,
      section: 'Общестроительные работы',
      question: 'Кто вывозит строительный мусор?',
      answer: 'Подрядчик',
      accepted_decision: 'Вывоз мусора в объём ГП не входит',
      tz_clause: 'п. 3.4',
    }],
    characteristics: [{ name: 'Класс бетона', value: 'B25' }],
  });

  assert.ok(Array.isArray(issues));
  assert.ok(llm.calls.length > 1, 'большое ТЗ должно уйти в Стадию 2 несколькими частями');
  for (const call of llm.calls) {
    assert.ok(call.user.includes('Вывоз мусора в объём ГП не входит'), 'справочник Q&A обязан быть в каждой части');
    assert.ok(call.user.includes('Класс бетона'), 'таблица характеристик обязана быть в каждой части');
    assert.ok(/ТЗ — часть \d+\/\d+/.test(call.user), 'часть должна быть помечена в промте');
  }
});

// --- Стадия 5: полный текст, без усечения по 200000 символов -------------------

test('Стадия 5 (QC) видит ТЗ целиком: хвост документа попадает в одну из частей', () => {
  const blocks = buildBigTz({ sections: 16 });
  const chars = totalChars(blocks);
  assert.ok(chars > 250_000, `нужен текст длиннее прежнего усечения, получено ${chars}`);

  const segments = segmentsForQc({ tzBlocks: blocks, budgetTokens: 8000 });
  assert.ok(segments.length > 1);

  const lastBlock = blocks[blocks.length - 1];
  const covered = segments.some((s) => s.contentBlocks.some((b) => b.index === lastBlock.index));
  assert.ok(covered, 'последний блок ТЗ не попал ни в одну часть — самоанализ снова смотрит только начало');

  // И плоский текст (когда блоков нет) тоже не обрезается, а дробится.
  const flatText = 'Заказчик передаёт площадку в состоянии, пригодном для производства работ. '.repeat(4200);
  const flat = segmentsForQc({ tzText: flatText, budgetTokens: 5000 });
  assert.ok(flat.length > 1, 'плоский текст должен дробиться, а не уходить одним куском');
  const tail = flatText.slice(-200);
  assert.ok(
    flat.some((s) => s.contentBlocks.some((b) => b.text.includes(tail))),
    `хвост плоского текста (${flatText.length} симв) потерян — усечение вернулось`,
  );
});

// --- Межраздельная сверка ------------------------------------------------------

test('дедуп швов: точный повтор и вложенная цитата сливаются, критичность берётся максимальная', () => {
  const res = dedupeAcrossSegments([
    { fragment: 'Подрядчик вывозит мусор своими силами.', problem_type: 'типовой_риск', criticality: 'medium', basis: 'кратко', segments: [2] },
    { fragment: 'подрядчик  вывозит мусор   своими силами.', problem_type: 'типовой_риск', criticality: 'high', basis: 'развёрнутое основание находки', segments: [3] },
    { fragment: 'вывозит мусор своими силами', problem_type: 'типовой_риск', criticality: 'low', basis: 'кусок', segments: [3] },
    { fragment: 'Подрядчик вывозит мусор своими силами.', problem_type: 'условие_противоречит', criticality: 'high', basis: 'другой домен', segments: [2] },
  ]);

  assert.equal(res.findings.length, 2, 'должны остаться две находки: риск и условие');
  assert.equal(res.stats.mergedExact, 1);
  assert.equal(res.stats.mergedNested, 1);
  const risk = res.findings.find((f) => f.problem_type === 'типовой_риск');
  assert.equal(risk.criticality, 'high', 'при слиянии берём максимальную критичность');
  assert.equal(risk.basis, 'развёрнутое основание находки', 'при слиянии берём самое полное основание');
  assert.deepEqual(risk.segments, [2, 3], 'провенанс частей сохраняется');
});

test('вердикт сверки: повторы убираются, межраздельная связь поднимает критичность и пишет пометку', () => {
  const findings = [
    { fragment: 'A', criticality: 'medium', review_comment: 'исходный комментарий' },
    { fragment: 'B', criticality: 'low' },
    { fragment: 'C', criticality: 'low' },
  ];
  const ids = ['f1', 'f2', 'f3'];
  const res = applyReconciliation(findings, {
    duplicates: [{ keep_id: 'f1', drop_ids: ['f2'] }],
    cross_section: [{
      finding_ids: ['f1', 'f3'],
      kind: 'contradiction',
      comment: 'Раздел 4 требует того, что раздел 12 запрещает.',
      criticality: 'high',
    }],
  }, ids);

  assert.equal(res.findings.length, 2);
  assert.equal(res.stats.dropped, 1);
  assert.equal(res.stats.groups, 1);
  const a = res.findings.find((f) => f.fragment === 'A');
  assert.equal(a.criticality, 'high', 'противоречие разделов повышает критичность');
  assert.ok(a.review_comment.includes('исходный комментарий'), 'исходный комментарий не затирается');
  assert.ok(a.review_comment.includes('Межраздельная сверка (противоречие разделов)'));
  const c = res.findings.find((f) => f.fragment === 'C');
  assert.equal(c.cross_section.kind, 'contradiction');
});

test('вердикт сверки не понижает критичность и игнорирует выдуманные id', () => {
  const findings = [{ fragment: 'A', criticality: 'critical' }];
  const res = applyReconciliation(findings, {
    duplicates: [{ keep_id: 'нет-такого', drop_ids: ['f1'] }],
    cross_section: [{ finding_ids: ['f1', 'призрак'], kind: 'escalate', comment: 'x', criticality: 'low' }],
  }, ['f1']);
  assert.equal(res.findings.length, 1, 'находку нельзя удалить по несуществующему keep_id');
  assert.equal(res.findings[0].criticality, 'critical', 'критичность не понижается сверкой');
  assert.equal(res.stats.groups, 1);
  assert.equal(res.stats.annotated, 0, 'группа из одной реальной находки не аннотируется');
});
