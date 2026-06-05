'use strict';

// Единый анализатор ТЗ — второй шаг новой архитектуры, поверх слоя signals.
//
// Берёт исходный текст ТЗ + ВСЕ signals по tender_id и формирует единый список
// draft_issues: сигналы, указывающие на одно место ТЗ (абзац + перекрытие
// char-диапазонов; фолбэк — нормализованная цитата), сводятся в один draft_issue.
// У каждого draft_issue видно: на какой пункт ТЗ он ссылается (tz_clause),
// на каких сигналах основан (created_from_signal_ids), краткое основание (basis)
// и предлагаемое действие (suggested_action).
//
// ПАРАЛЛЕЛЬНЫЙ слой: не трогает issues / review / export. Группировка/маппинг —
// чистые функции (тестируются без БД), как в review/consolidation.js.

const db = require('../../db/connection');
const { newId, nowIso } = require('../../utils/ids');
const { getActiveTzText } = require('../tzActiveTextService');

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
  };
}

// Группировка по месту ТЗ. Локализуемые (paragraph_index + char) — sweep-merge
// перекрытий внутри абзаца; безъякорные — по нормализованной цитате.
function groupSignals(signals) {
  const groups = [];
  const byPara = new Map();
  const byFragment = new Map();

  for (const s of signals) {
    const hasLoc = s.paragraph_index != null && s.char_start != null && s.char_end != null;
    if (hasLoc) {
      if (!byPara.has(s.paragraph_index)) byPara.set(s.paragraph_index, []);
      byPara.get(s.paragraph_index).push(s);
    } else {
      const norm = normalizeFragment(s.source_fragment);
      const key = norm ? `frag:${norm}` : `uniq:${s.id}`;
      if (!byFragment.has(key)) byFragment.set(key, []);
      byFragment.get(key).push(s);
    }
  }

  for (const arr of byPara.values()) {
    arr.sort((a, b) => (a.char_start - b.char_start) || (a.char_end - b.char_end));
    let cur = null;
    let curEnd = -1;
    for (const s of arr) {
      if (cur && s.char_start <= curEnd) {
        cur.push(s);
        curEnd = Math.max(curEnd, s.char_end);
      } else {
        cur = [s];
        curEnd = s.char_end;
        groups.push(cur);
      }
    }
  }
  for (const arr of byFragment.values()) groups.push(arr);
  return groups;
}

// primary сигнал группы: по критичности, затем по весу, затем по стадии/позиции.
function pickPrimary(group) {
  return [...group].sort(
    (a, b) =>
      critRank(b) - critRank(a) ||
      (b.weight || 0) - (a.weight || 0) ||
      (a.analysis_stage || 99) - (b.analysis_stage || 99) ||
      ((a.char_start ?? 0) - (b.char_start ?? 0)),
  )[0];
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

  return {
    id: newId(),
    tender_id: tenderId,
    tz_clause: primary.tz_clause || members.map((m) => m.tz_clause).find(Boolean) || null,
    source_fragment: fragment,
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

async function loadSignals(tenderId) {
  const rows = await db.queryAll(
    `SELECT * FROM analysis_signals WHERE tender_id = ? ORDER BY analysis_stage ASC, created_at ASC`,
    tenderId,
  );
  return rows.map(flattenSignal);
}

// Главная функция: собрать draft_issues по тендеру и сохранить (idempotent —
// перезапись прежнего набора для этого тендера).
async function buildDraftIssues(tenderId) {
  const flat = await loadSignals(tenderId);

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
    await tx.queryRun(`DELETE FROM draft_issues WHERE tender_id = ?`, tenderId);
    const createdAt = nowIso();
    for (const d of drafts) {
      await tx.queryRun(
        `INSERT INTO draft_issues (
           id, tender_id, tz_clause, source_fragment, problem_type, category,
           basis, suggested_action, suggested_redaction, review_comment,
           confidence, created_from_signal_ids, paragraph_index, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        d.id, d.tender_id, d.tz_clause, d.source_fragment, d.problem_type, d.category,
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
  const rows = await db.queryAll(
    `SELECT * FROM draft_issues WHERE tender_id = ? ORDER BY paragraph_index ASC NULLS LAST, created_at ASC`,
    tenderId,
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
