'use strict';

// Challenger — независимый поиск пропусков основных стадий (чистое ядро
// stage5Challenger): дайджест уже найденного, детерминированный анти-дубль и
// разделение ролей со стадией-QC. Запуск: npm run test:unit.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  CHALLENGER_PROBLEM_TYPES,
  SYSTEM_PROMPT,
  buildCoveredDigest,
  renderCovered,
  isCoveredByExisting,
} = require('../../services/stageAnalysis/stage5Challenger');
const { LLM_FINDING_TYPES } = require('../../services/stageAnalysis/stage5_llm');
const { STAGE_DOMAINS, isOwnedBy } = require('../../services/review/stageDomains');
const { signalTypeForStage } = require('../../services/signals/signalWriter');
const { SIGNAL_STAGES } = require('../../services/stageAnalysis/publishStageResult');

// --- Разделение ролей ----------------------------------------------------------

test('роли разделены: QC не ищет пропуски, challenger не пишет QC-заметок', () => {
  // QC-агент больше не выдаёт missed_coverage (прежнее противоречие промта).
  assert.ok(!LLM_FINDING_TYPES.includes('missed_coverage'));
  // QC проверяет шесть аспектов качества из ТЗ пользователя.
  for (const t of ['weak_cluster', 'no_consequence', 'needs_enrichment',
    'duplicate_cluster', 'cluster_contradiction', 'overstated_criticality']) {
    assert.ok(LLM_FINDING_TYPES.includes(t), t);
  }
  // Типы challenger-находок принадлежат домену Стадии 5 — движковый гард не
  // посчитает их чужими.
  for (const t of CHALLENGER_PROBLEM_TYPES) {
    assert.ok(isOwnedBy(5, t), `${t} в домене стадии 5`);
  }
  assert.ok(STAGE_DOMAINS[5].problemTypes.includes('пропущенный_риск'));
});

test('находки challenger идут в конвейер: стадия 5 эмитит сигналы типа challenger', () => {
  assert.equal(signalTypeForStage(5), 'challenger');
  assert.ok(SIGNAL_STAGES.includes(5));
});

test('промт challenger не содержит запрета искать заново (снятое противоречие)', () => {
  assert.match(SYSTEM_PROMPT, /ИЩЕШЬ ЗАНОВО/);
  assert.match(SYSTEM_PROMPT, /ПРОПУСТИЛИ/);
  assert.doesNotMatch(SYSTEM_PROMPT, /НЕ искать замечания/i);
});

// --- Дайджест покрытого ---------------------------------------------------------

test('buildCoveredDigest сжимает кластер до места + темы + цитаты', () => {
  const digest = buildCoveredDigest([{
    tz_clause: 'п. 4.2',
    cluster_title: 'Уборка и вывоз мусора',
    representative_fragment: 'Подрядчик обязан обеспечить ежедневную уборку строительной площадки.',
  }]);
  assert.equal(digest.length, 1);
  assert.equal(digest[0].place, 'п. 4.2');
  assert.match(renderCovered(digest), /Уборка и вывоз мусора/);
});

test('renderCovered на пустом итоге явно говорит: любой материальный риск — пропуск', () => {
  assert.match(renderCovered([]), /любой материальный риск/);
});

// --- Детерминированный анти-дубль ----------------------------------------------

const COVERED = ['подрядчик обязан обеспечить ежедневную уборку строительной площадки'];

test('цитата, вложенная в покрытую (или наоборот), отбрасывается как повтор', () => {
  assert.equal(isCoveredByExisting('обеспечить ежедневную уборку строительной площадки', COVERED), true);
  assert.equal(
    isCoveredByExisting('Подрядчик обязан обеспечить ежедневную уборку строительной площадки и вывоз мусора', COVERED),
    true,
  );
});

test('непокрытая цитата проходит; короткие обрывки не дают ложных совпадений', () => {
  assert.equal(isCoveredByExisting('Гарантийный срок составляет 10 лет с даты ввода объекта', COVERED), false);
  assert.equal(isCoveredByExisting('уборку', COVERED), false, 'короче порога — не повод дропать');
});
