'use strict';

// Слой сборки итога: из находок 5 стадий делает ОДИН результат.
// Находки, указывающие на одно и то же место ТЗ (тот же абзац + перекрытие
// символьных диапазонов; фолбэк — точная цитата), группируются. В группе
// выбирается primary (по критичности; тай-брейк — порядок стадий, затем char_start),
// прочие — related. Конфликт помечается (решает инженер — ничего не теряем).
// Тот же слой переиспользует экспорт (дедуп по месту: применяется решение primary).

// db подгружается лениво в loadAllIssues — чтобы чистые функции (группировка,
// primary, дедуп) тестировались без подключения к БД.
const { decisionVisual } = require('./decisionModel');

const CRIT_RANK = { critical: 4, high: 3, medium: 2, low: 1 };
function critRank(i) { return CRIT_RANK[i && i.criticality] || 0; }

function normalizeFragment(s) {
  return (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Решение по issue: явное d.decision_kind или вывод из review_status.
function deriveDecisionKind(i) {
  if (i.decision_kind) return i.decision_kind;
  if (i.review_status === 'edited') return 'edit';
  if (i.review_status === 'accepted') return 'accept';
  if (i.review_status === 'rejected') return 'reject';
  return null; // pending
}

// Грубый «эффект» решения для конфликтов/вердикта.
function coarseEffect(i) {
  const kind = deriveDecisionKind(i);
  if (!kind) return 'pending';
  const docx = decisionVisual(kind).docx; // del | del+ins | comment | none
  if (docx === 'none') return 'reject';
  if (docx === 'comment') return 'comment';
  return 'change'; // del / del+ins
}

// Группировка по месту ТЗ. Локализуемые (paragraph_index+char) — sweep-merge
// перекрытий внутри абзаца; безъякорные — по нормализованной цитате.
function groupIssues(issues) {
  const groups = [];
  const byPara = new Map();
  const byFragment = new Map();

  for (const i of issues) {
    const hasLoc = i.paragraph_index != null && i.char_start != null && i.char_end != null;
    if (hasLoc) {
      if (!byPara.has(i.paragraph_index)) byPara.set(i.paragraph_index, []);
      byPara.get(i.paragraph_index).push(i);
    } else {
      const norm = normalizeFragment(i.source_fragment);
      const key = norm ? `frag:${norm}` : `uniq:${i.id}`;
      if (!byFragment.has(key)) byFragment.set(key, []);
      byFragment.get(key).push(i);
    }
  }

  for (const arr of byPara.values()) {
    arr.sort((a, b) => (a.char_start - b.char_start) || (a.char_end - b.char_end));
    let cur = null;
    let curEnd = -1;
    for (const i of arr) {
      if (cur && i.char_start <= curEnd) {
        cur.push(i);
        curEnd = Math.max(curEnd, i.char_end);
      } else {
        cur = [i];
        curEnd = i.char_end;
        groups.push(cur);
      }
    }
  }
  for (const arr of byFragment.values()) groups.push(arr);
  return groups;
}

// primary группы: по критичности, затем порядок стадий, затем char_start.
function pickPrimary(group) {
  return [...group].sort(
    (a, b) =>
      critRank(b) - critRank(a) ||
      (a.analysis_stage || 99) - (b.analysis_stage || 99) ||
      ((a.char_start ?? 0) - (b.char_start ?? 0)),
  )[0];
}

function slim(i) {
  return {
    id: i.id,
    stage: i.analysis_stage,
    problem_type: i.problem_type,
    risk_category: i.risk_category,
    criticality: i.criticality,
    review_status: i.review_status,
    decision_kind: deriveDecisionKind(i),
    suggested_action: i.suggested_action,
    fragment: (i.source_fragment || '').slice(0, 200),
    section_path: i.section_path,
    basis: i.basis,
  };
}

function verdictOf(primary) {
  const e = coarseEffect(primary);
  if (e === 'change') return 'review_edit';
  if (e === 'comment') return 'review_comment';
  if (e === 'reject') return 'rejected';
  return 'pending';
}

function buildGroup(members) {
  const primary = pickPrimary(members);
  const related = members.filter((i) => i.id !== primary.id);
  const stages = [...new Set(members.map((i) => i.analysis_stage))].sort((a, b) => a - b);
  const coarse = members.map(coarseEffect).filter((e) => e !== 'pending');
  const conflict = new Set(coarse).size > 1;
  const pendingCount = members.filter((i) => coarseEffect(i) === 'pending').length;
  return {
    id: String(primary.id),
    paragraph_index: primary.paragraph_index ?? null,
    fragment: (primary.source_fragment || '').slice(0, 200),
    stages,
    multi_stage: stages.length > 1,
    conflict,
    pending_count: pendingCount,
    verdict: verdictOf(primary),
    primary: slim(primary),
    related: related.map(slim),
  };
}

async function loadAllIssues(tenderId) {
  const db = require('../../db/connection');
  return db.queryAll(
    `
      SELECT i.*, d.decision AS decision_kind, d.final_comment AS final_comment,
             d.edited_redaction AS decision_redaction
      FROM issues i
      LEFT JOIN review_decisions d ON d.issue_id = i.id
      WHERE i.tender_id = ?
      ORDER BY i.paragraph_index ASC NULLS LAST, i.char_start ASC NULLS LAST, i.analysis_stage ASC
    `,
    tenderId,
  );
}

// Главная функция сборки: один итог по тендеру.
async function consolidate(tenderId) {
  const issues = await loadAllIssues(tenderId);
  const groups = groupIssues(issues).map(buildGroup);
  // Стабильный порядок: по месту, затем по primary-стадии.
  groups.sort(
    (a, b) =>
      (a.paragraph_index ?? 1e9) - (b.paragraph_index ?? 1e9) ||
      (a.primary.stage || 99) - (b.primary.stage || 99),
  );

  const summary = {
    findings: issues.length,
    groups: groups.length,
    multi_stage: groups.filter((g) => g.multi_stage).length,
    conflicts: groups.filter((g) => g.conflict).length,
    review_edit: groups.filter((g) => g.verdict === 'review_edit').length,
    review_comment: groups.filter((g) => g.verdict === 'review_comment').length,
    rejected: groups.filter((g) => g.verdict === 'rejected').length,
    pending: groups.filter((g) => g.verdict === 'pending').length,
  };
  return { summary, groups };
}

// Дедуп для экспорта: на одно место — решение primary, остальные — дубли.
// items: [{ issue, decision_kind, ... }] (как в exportController.loadDecisions).
function dedupeExportDecisions(items) {
  const itemByIssueId = new Map(items.map((it) => [it.issue.id, it]));
  const groups = groupIssues(items.map((it) => it.issue));
  const kept = [];
  const duplicates = [];
  for (const g of groups) {
    const primary = pickPrimary(g);
    kept.push(itemByIssueId.get(primary.id));
    for (const i of g) if (i.id !== primary.id) duplicates.push(itemByIssueId.get(i.id));
  }
  kept.sort(
    (a, b) =>
      ((a.issue.paragraph_index ?? 1e9) - (b.issue.paragraph_index ?? 1e9)) ||
      ((a.issue.char_start ?? 0) - (b.issue.char_start ?? 0)) ||
      ((a.issue.analysis_stage || 99) - (b.issue.analysis_stage || 99)),
  );
  return { kept, duplicates };
}

module.exports = {
  consolidate,
  dedupeExportDecisions,
  // экспортируем для офлайн-тестов:
  groupIssues,
  pickPrimary,
  buildGroup,
};
