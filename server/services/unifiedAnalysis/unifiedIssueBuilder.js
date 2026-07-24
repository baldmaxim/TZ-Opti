'use strict';

// Единый анализатор ТЗ — второй шаг новой архитектуры, поверх слоя signals.
//
// Берёт исходный текст ТЗ + ВСЕ signals по tender_id и формирует единый список
// draft_issues. Сигналы группируются в два прохода: (1) по МЕСТУ ТЗ (абзац или
// безъякорная цитата), (2) внутри места — по СМЫСЛУ (тип проблемы + семейство
// действия + категория + совместимость рекомендаций). Пересечение char-диапазонов
// само по себе НЕ объединяет сигналы: один абзац может дать несколько независимых
// draft_issues (разные проблемы), а совпадающие по смыслу сигналы (в т.ч. из
// разных стадий) собираются как несколько ДОКАЗАТЕЛЬСТВ одного замечания.
// У каждого draft_issue видно: на какой пункт ТЗ он ссылается (tz_clause),
// на каких сигналах основан (created_from_signal_ids), краткое основание (basis)
// и предлагаемое действие (suggested_action).
//
// ПАРАЛЛЕЛЬНЫЙ слой: не трогает issues / review / export. Группировка/маппинг —
// чистые функции (тестируются без БД), как в review/consolidation.js.

const db = require('../../db/connection');
const { newId, nowIso } = require('../../utils/ids');
const { getActiveTzText } = require('../tzActiveTextService');
const { backfillSignalsFromIssues } = require('../signals/signalWriter');
const { actionFamily } = require('../analysis/actions');
const analysisRuns = require('../analysisRuns/analysisRunsService');

const CRIT_RANK = { critical: 4, high: 3, medium: 2, low: 1 };
function critRank(s) { return CRIT_RANK[s && s.criticality] || 0; }

function safeParse(s) {
  if (!s) return {};
  try { return JSON.parse(s) || {}; } catch (_e) { return {}; }
}

function normalizeFragment(s) {
  return (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Плоская форма сигнала с распакованным payload — удобно для группировки/маппинга.
function flattenSignal(row) {
  const p = safeParse(row.signal_payload_json);
  return {
    id: row.id,
    signal_type: row.signal_type,
    analysis_stage: row.analysis_stage,
    tz_clause: row.tz_clause || p.section_path || null,
    source_fragment: row.source_fragment || null,
    weight: typeof row.weight === 'number' ? row.weight : 0.6,
    problem_type: p.problem_type || null,
    risk_category: p.risk_category || null,
    criticality: p.criticality || 'medium',
    suggested_action: p.suggested_action || null,
    suggested_redaction: p.suggested_redaction || null,
    review_comment: p.review_comment || null,
    basis: p.basis || null,
    paragraph_index: p.paragraph_index ?? null,
    char_start: p.char_start ?? null,
    char_end: p.char_end ?? null,
    context_text: p.context_text || null,
  };
}

function normLower(s) {
  return (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// --- Совместимость сигналов как ОДНОГО замечания -----------------------------
//
// Ключевое правило фикса: пересечение char-диапазонов НЕ является достаточным
// основанием объединять сигналы (иначе несколько находок одного абзаца сливались
// в один draft_issue и терялись). Два сигнала — одно замечание только если это
// ОДНА проблема: совпадают тип проблемы, семейство действия и смысл (категория),
// а рекомендации не конфликтуют. Пустое поле «совместимо с любым» (сигнал-
// доказательство без своей рекомендации усиливает замечание, а не спорит с ним).

function sameProblemType(a, b) {
  const pa = normLower(a.problem_type);
  const pb = normLower(b.problem_type);
  return !(pa && pb && pa !== pb);
}
function sameActionFamily(a, b) {
  return actionFamily(a.suggested_action) === actionFamily(b.suggested_action);
}
function sameMeaning(a, b) {
  const ca = normLower(a.risk_category);
  const cb = normLower(b.risk_category);
  return !(ca && cb && ca !== cb);
}
function recommendationsCompatible(a, b) {
  const ra = normLower(a.suggested_redaction);
  const rb = normLower(b.suggested_redaction);
  return !(ra && rb && ra !== rb); // разные непустые правки конфликтуют
}
function isSameIssue(a, b) {
  return sameProblemType(a, b)
    && sameActionFamily(a, b)
    && sameMeaning(a, b)
    && recommendationsCompatible(a, b);
}

// Место ТЗ: абзац (по индексу) либо безъякорная цитата. Char-диапазон здесь НЕ
// используется для слияния — только чтобы понять, что сигналы про один пункт.
function placeKey(s) {
  if (s.paragraph_index != null) return `para:${s.paragraph_index}`;
  const norm = normalizeFragment(s.source_fragment);
  return norm ? `frag:${norm}` : `uniq:${s.id}`;
}

// «Сила» сигнала: критичность → вес → стадия → позиция. Сильнейший становится
// primary своей семантической группы (эталоном совместимости).
function byStrength(a, b) {
  return critRank(b) - critRank(a)
    || (b.weight || 0) - (a.weight || 0)
    || (a.analysis_stage || 99) - (b.analysis_stage || 99)
    || ((a.char_start ?? 0) - (b.char_start ?? 0));
}

// Группировка сигналов в замечания. Сначала — по МЕСТУ ТЗ (абзац/цитата), затем
// внутри места — по СМЫСЛУ: сигнал присоединяется к первой совместимой группе
// (по её primary) либо открывает новую. Так один абзац порождает НЕСКОЛЬКО
// независимых draft_issues, а совпадающие по смыслу сигналы (в т.ч. из разных
// стадий) собираются как НЕСКОЛЬКО ДОКАЗАТЕЛЬСТВ одного замечания.
function groupSignals(signals) {
  const byPlace = new Map();
  for (const s of signals) {
    const key = placeKey(s);
    if (!byPlace.has(key)) byPlace.set(key, []);
    byPlace.get(key).push(s);
  }

  const groups = [];
  for (const place of byPlace.values()) {
    const ordered = [...place].sort(byStrength);
    const local = []; // группы этого места; local[i][0] — primary группы
    for (const s of ordered) {
      const g = local.find((grp) => isSameIssue(grp[0], s));
      if (g) g.push(s);
      else local.push([s]);
    }
    for (const g of local) groups.push(g);
  }
  return groups;
}

// primary сигнал группы: по критичности, затем по весу, затем по стадии/позиции.
function pickPrimary(group) {
  return [...group].sort(byStrength)[0];
}

function longestFragment(members) {
  return members
    .map((m) => m.source_fragment || '')
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)[0] || null;
}

// Сводит группу сигналов в один draft_issue.
// tzBlockText(paragraph_index) — опциональный резолвер текста абзаца ТЗ (фолбэк фрагмента).
function buildDraftFromGroup(members, tenderId, tzBlockText) {
  const primary = pickPrimary(members);
  const types = [...new Set(members.map((m) => m.signal_type))].sort();
  const distinctTypes = types.length;

  // Уверенность растёт при подтверждении несколькими источниками (с потолком).
  const maxWeight = Math.max(...members.map((m) => m.weight || 0));
  const confidence = Math.min(0.99, Math.round((maxWeight + 0.05 * (distinctTypes - 1)) * 100) / 100);

  let basis = primary.basis || '';
  if (members.length > 1) {
    basis = (basis ? basis + ' ' : '') +
      `[сведено из ${members.length} сигналов: ${types.join(', ')}]`;
  }

  const paragraphIndex = primary.paragraph_index ?? null;
  const fragment = primary.source_fragment
    || longestFragment(members)
    || (paragraphIndex != null && tzBlockText ? tzBlockText(paragraphIndex) : null);
  // Полный абзац-контекст: из сигналов (context_text) либо резолвим по абзацу ТЗ.
  const contextText = members.map((m) => m.context_text).find(Boolean)
    || (paragraphIndex != null && tzBlockText ? tzBlockText(paragraphIndex) : null)
    || null;

  return {
    id: newId(),
    tender_id: tenderId,
    tz_clause: primary.tz_clause || members.map((m) => m.tz_clause).find(Boolean) || null,
    source_fragment: fragment,
    context_text: contextText,
    problem_type: primary.problem_type || null,
    category: distinctTypes === 1 ? types[0] : types.join('+'),
    basis: basis || null,
    suggested_action: primary.suggested_action || null,
    suggested_redaction: primary.suggested_redaction || null,
    review_comment: primary.review_comment || null,
    confidence,
    created_from_signal_ids: members.map((m) => m.id),
    paragraph_index: paragraphIndex,
  };
}

// Чистое ядро: список сигналов (плоских) -> список draft_issues. Без БД.
function assembleDrafts(flatSignals, tenderId, tzBlockText) {
  const groups = groupSignals(flatSignals).map((g) => buildDraftFromGroup(g, tenderId, tzBlockText));
  groups.sort(
    (a, b) =>
      (a.paragraph_index ?? 1e9) - (b.paragraph_index ?? 1e9) ||
      (b.confidence || 0) - (a.confidence || 0),
  );
  return groups;
}

// --- DB-обвязка -------------------------------------------------------------

// Читает сигналы ТОЛЬКО актуальных stage-прогонов (согласованный набор снимка).
async function loadSignals(tenderId, stageRunIds) {
  if (!stageRunIds || !stageRunIds.length) return [];
  const ph = stageRunIds.map(() => '?').join(', ');
  const rows = await db.queryAll(
    `SELECT * FROM analysis_signals
      WHERE tender_id = ? AND analysis_run_id IN (${ph})
      ORDER BY analysis_stage ASC, created_at ASC`,
    tenderId, ...stageRunIds,
  );
  return rows.map(flattenSignal);
}

// Самовосстановление слоя signals: если сигналов актуальных stage-прогонов нет,
// но их issues есть (тендер прогнан раньше — сигналы не записались/очищены),
// достраиваем сигналы из issues (привязка к актуальному stage-прогону).
async function ensureSignals(tenderId) {
  const stageRunIds = await analysisRuns.getActiveStageRunIds(tenderId);
  if (stageRunIds.length) {
    const ph = stageRunIds.map(() => '?').join(', ');
    const row = await db.queryOne(
      `SELECT COUNT(*) AS c FROM analysis_signals WHERE tender_id = ? AND analysis_run_id IN (${ph})`,
      tenderId, ...stageRunIds,
    );
    if (Number(row && row.c) > 0) return;
  }
  await backfillSignalsFromIssues(tenderId);
}

// Главная функция: собрать draft_issues по тендеру и сохранить (idempotent —
// перезапись прежнего набора для этого тендера).
async function buildDraftIssues(tenderId, runId) {
  const rid = runId || await analysisRuns.ensurePipelineRun(tenderId);
  await ensureSignals(tenderId);
  const stageRunIds = await analysisRuns.getActiveStageRunIds(tenderId);
  const flat = await loadSignals(tenderId, stageRunIds);

  // Исходный текст ТЗ — для резолва фрагмента по абзацу, когда сигнал безъякорный.
  let tzBlockText = null;
  try {
    const tz = await getActiveTzText(tenderId);
    if (tz && !tz.missingMd && Array.isArray(tz.blocks)) {
      const byIndex = new Map(tz.blocks.map((b) => [b.index, b.text]));
      tzBlockText = (idx) => byIndex.get(idx) || null;
    }
  } catch (_e) { /* ТЗ необязателен для сборки — фрагмент берём из сигналов */ }

  const drafts = assembleDrafts(flat, tenderId, tzBlockText);

  await db.transaction(async (tx) => {
    // Идемпотентность в пределах ПРОГОНА: чистим draft_issues только этого rid
    // (не трогаем прошлые снимки — архивация).
    await tx.queryRun(`DELETE FROM draft_issues WHERE tender_id = ? AND analysis_run_id = ?`, tenderId, rid);
    const createdAt = nowIso();
    for (const d of drafts) {
      await tx.queryRun(
        `INSERT INTO draft_issues (
           id, tender_id, analysis_run_id, tz_clause, source_fragment, problem_type, category,
           basis, suggested_action, suggested_redaction, review_comment,
           confidence, created_from_signal_ids, paragraph_index, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        d.id, d.tender_id, rid, d.tz_clause, d.source_fragment, d.problem_type, d.category,
        d.basis, d.suggested_action, d.suggested_redaction, d.review_comment,
        d.confidence, JSON.stringify(d.created_from_signal_ids), d.paragraph_index, createdAt,
      );
    }
  });

  return {
    summary: {
      signals: flat.length,
      draft_issues: drafts.length,
      by_category: drafts.reduce((acc, d) => {
        acc[d.category] = (acc[d.category] || 0) + 1;
        return acc;
      }, {}),
      multi_signal: drafts.filter((d) => d.created_from_signal_ids.length > 1).length,
    },
    items: drafts,
  };
}

async function listDraftIssues(tenderId) {
  const rid = await analysisRuns.getActivePipelineRunId(tenderId);
  if (!rid) return [];
  const rows = await db.queryAll(
    `SELECT * FROM draft_issues WHERE tender_id = ? AND analysis_run_id = ?
      ORDER BY paragraph_index ASC NULLS LAST, created_at ASC`,
    tenderId, rid,
  );
  return rows.map((r) => ({
    ...r,
    created_from_signal_ids: safeParse(r.created_from_signal_ids) || [],
  }));
}

module.exports = {
  buildDraftIssues,
  listDraftIssues,
  // экспортируем чистое ядро для офлайн-тестов/демо:
  flattenSignal,
  groupSignals,
  buildDraftFromGroup,
  assembleDrafts,
};
