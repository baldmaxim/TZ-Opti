'use strict';

// ЧИСТОЕ ядро билдера согласованной версии ТЗ (без БД, офлайн-тесты).
//
// Вход: сырая md-строка + блоки с offset'ами (mdParser: md_start/md_end) +
// снимок кластерных решений инженера. Выход: новый md-текст + отчёт применения.
//
// Ключевые правила:
//   • Правится СЫРАЯ md-строка (не блоки): parseMdToBlocks теряет разметку
//     (# заголовков, | таблиц), блоки — только якорь для поиска места.
//   • delete / remove_from_scope — ко ВСЕМ вхождениям кластера
//     (evidence_fragments): решение семантически про требование, не про место.
//     Если инженер выбрал подчасть (target_text) — вырезается только она, и
//     только там, где найдена дословно (не найдена → skipped_occurrence).
//   • edit — замена ко всем вхождениям, где целевой текст найден ДОСЛОВНО;
//     для главного (representative) вхождения — каскад точный → tolerant.
//     Ненайденные вхождения — skipped_occurrence (fail-safe: замена, сочинённая
//     под контекст одного абзаца, в другом может быть неприменима).
//   • accept / reject — текст не меняют (accept станет Word-комментарием при
//     экспорте, reject не экспортируется вовсе).
//   • Все операции собираются в координатах сырой строки, сортируются,
//     пересечения решаются «первое решение выигрывает» (второе — conflict),
//     применение — справа налево: координатный дрейф исключён по построению.
//   • Не нашли фрагмент — failed, текст НЕ трогается.

const { resolveRedaction } = require('../review/decisionModel');

const TEXT_CHANGING = new Set(['edit', 'delete', 'remove_from_scope']);

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeForLocate(s) {
  return (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Точный поиск подстроки. Возвращает {start, end} в координатах haystack или null.
function findExact(haystack, needle) {
  const i = haystack.indexOf(needle);
  return i === -1 ? null : { start: i, end: i + needle.length };
}

// Терпимый к пробелам поиск (включая NBSP/узкие пробелы и переводы строк):
// каждая пробельная последовательность needle матчится на любую пробельную
// последовательность haystack. Возвращает РЕАЛЬНЫЕ смещения или null.
function findTolerant(haystack, needle) {
  const trimmed = (needle || '').trim();
  if (!trimmed) return null;
  const pattern = trimmed
    .split(/\s+/)
    .map(escapeRegExp)
    .join('[\\s\\u00A0\\u202F]+');
  try {
    const re = new RegExp(pattern);
    const m = re.exec(haystack);
    return m ? { start: m.index, end: m.index + m[0].length } : null;
  } catch (_e) {
    return null;
  }
}

// Якорный блок вхождения: по paragraph_index (с проверкой, что фрагмент там
// действительно есть), иначе — первый блок, содержащий фрагмент.
function anchorBlockFor(blocks, occurrence) {
  const frag = normalizeForLocate(occurrence.fragment);
  if (!frag) return null;
  if (occurrence.paragraph_index != null) {
    const byIndex = blocks.find((b) => b.index === occurrence.paragraph_index);
    if (byIndex && normalizeForLocate(byIndex.text).includes(frag)) return byIndex;
  }
  return blocks.find((b) => normalizeForLocate(b.text).includes(frag)) || null;
}

// Срез сырой md-строки, в котором ищем вхождение. Блок без offset'ов (легаси)
// деградирует до всего документа.
function rawSliceFor(rawMd, block) {
  if (block && Number.isFinite(block.md_start) && Number.isFinite(block.md_end)) {
    return { start: block.md_start, end: block.md_end };
  }
  return { start: 0, end: rawMd.length };
}

// Найти target внутри вхождения. exactOnly=true — только дословно (без tolerant).
function locateInRaw(rawMd, block, target, { exactOnly = false } = {}) {
  const slice = rawSliceFor(rawMd, block);
  const hay = rawMd.slice(slice.start, slice.end);
  let hit = findExact(hay, target);
  let method = 'exact';
  if (!hit && !exactOnly) {
    hit = findTolerant(hay, target);
    method = 'tolerant';
  }
  if (!hit) return null;
  return { start: slice.start + hit.start, end: slice.start + hit.end, method, slice };
}

// Дедупликация вхождений кластера: несколько draft_issues могут указывать на
// одно место (paragraph_index + нормализованный фрагмент).
function uniqueOccurrences(decision) {
  const raw = Array.isArray(decision.evidence_fragments) && decision.evidence_fragments.length
    ? decision.evidence_fragments
    : [];
  const list = raw
    .map((e) => ({ paragraph_index: e.paragraph_index ?? null, fragment: (e.fragment || '').trim() }))
    .filter((e) => e.fragment);
  // representative — всегда вхождение (даже если evidence_fragments пуст/легаси).
  const rep = (decision.representative_fragment || '').trim();
  if (rep && !list.some((e) => normalizeForLocate(e.fragment) === normalizeForLocate(rep))) {
    list.unshift({ paragraph_index: decision.paragraph_index ?? null, fragment: rep });
  }
  const seen = new Set();
  const out = [];
  for (const occ of list) {
    const key = `${occ.paragraph_index}::${normalizeForLocate(occ.fragment)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(occ);
  }
  return out;
}

function isRepresentative(decision, occ) {
  const rep = normalizeForLocate(decision.representative_fragment || '');
  return rep && normalizeForLocate(occ.fragment) === rep;
}

// Операция для одного вхождения одного решения. null = вхождение пропущено
// (в отчёт пишет вызывающий).
function opForOccurrence(rawMd, blocks, decision, occ) {
  const kind = decision.decision;
  const block = anchorBlockFor(blocks, occ);
  const representative = isRepresentative(decision, occ);
  const part = (decision.target_text || '').trim();

  if (kind === 'delete' || kind === 'remove_from_scope') {
    // Подчасть: вырезаем только её и только где найдена дословно (для
    // representative — с tolerant-фолбэком). Без подчасти — всё вхождение.
    const target = part || occ.fragment;
    const exactOnly = Boolean(part) && !representative;
    const loc = locateInRaw(rawMd, block, target, { exactOnly });
    if (!loc) return { status: part ? 'skipped_occurrence' : 'failed', reason: 'фрагмент не найден в тексте' };
    return { status: 'applied', op: { start: loc.start, end: loc.end, replacement: '' }, method: loc.method };
  }

  if (kind === 'edit') {
    const replacement = resolveRedaction(
      { suggested_redaction: decision.suggested_redaction },
      { edited_redaction: decision.edited_redaction },
    );
    if (!replacement) return { status: 'failed', reason: 'у решения edit нет текста замены' };
    // Цель замены: выбранная подчасть или representative-фрагмент целиком.
    const target = part || (decision.representative_fragment || '').trim() || occ.fragment;
    const loc = locateInRaw(rawMd, block, target, { exactOnly: !representative });
    if (!loc) {
      return {
        status: representative ? 'failed' : 'skipped_occurrence',
        reason: 'целевой текст не найден дословно',
      };
    }
    return { status: 'applied', op: { start: loc.start, end: loc.end, replacement }, method: loc.method };
  }

  return { status: 'noop' };
}

// Если операция удаления накрыла блок целиком — забираем и завершающие переводы
// строк, чтобы не оставлять пустых абзацев.
function widenFullBlockDeletes(rawMd, blocks, ops) {
  const fullBlockStarts = new Map(
    blocks
      .filter((b) => Number.isFinite(b.md_start) && Number.isFinite(b.md_end))
      .map((b) => [b.md_start, b.md_end]),
  );
  return ops.map((op) => {
    if (op.replacement !== '' || fullBlockStarts.get(op.start) !== op.end) return op;
    let end = op.end;
    while (end < rawMd.length && (rawMd[end] === '\n' || rawMd[end] === '\r')) end += 1;
    return { ...op, end };
  });
}

// Пересечения операций: первое решение (по порядку на входе) выигрывает,
// последующие пересекающиеся уходят в conflict.
function resolveOverlaps(entries) {
  const accepted = [];
  const isOverlap = (a, b) => a.op.start < b.op.end && b.op.start < a.op.end;
  for (const entry of entries) {
    const clash = accepted.find((a) => isOverlap(a, entry));
    if (clash) {
      entry.status = 'conflict';
      entry.reason = `пересекается с решением ${clash.cluster_id || clash.seq}`;
      entry.op = null;
    } else {
      accepted.push(entry);
    }
  }
  return entries;
}

function applyOps(rawMd, ops) {
  const sorted = [...ops].sort((a, b) => b.start - a.start); // справа налево
  let text = rawMd;
  for (const op of sorted) {
    text = text.slice(0, op.start) + op.replacement + text.slice(op.end);
  }
  return text;
}

// --- Главная функция ----------------------------------------------------------
//
// decisions: [{ cluster_id, decision, target_text, edited_redaction,
//   suggested_redaction, representative_fragment, paragraph_index,
//   evidence_fragments: [{paragraph_index, fragment}, ...] }]
// Порядок решений значим: при конфликте места выигрывает более раннее.
function buildAgreedText({ rawMd, blocks, decisions }) {
  const md = (rawMd || '').toString();
  const report = {
    applied: 0, skipped: 0, failed: 0, conflicts: 0, noop: 0,
    perDecision: [],
  };
  const flatEntries = [];
  let seq = 0;

  for (const decision of decisions || []) {
    const kind = decision.decision;
    const perDec = { cluster_id: decision.cluster_id || null, decision: kind, occurrences: [] };
    report.perDecision.push(perDec);

    if (!TEXT_CHANGING.has(kind)) {
      perDec.occurrences.push({ status: 'noop' });
      continue;
    }

    const occurrences = uniqueOccurrences(decision);
    if (!occurrences.length) {
      perDec.occurrences.push({ status: 'failed', reason: 'у решения нет ни одного вхождения с цитатой' });
      continue;
    }

    for (const occ of occurrences) {
      const result = opForOccurrence(md, blocks || [], decision, occ);
      const occReport = {
        status: result.status,
        paragraph_index: occ.paragraph_index,
        fragment: occ.fragment.slice(0, 200),
      };
      if (result.reason) occReport.reason = result.reason;
      if (result.method) occReport.method = result.method;
      perDec.occurrences.push(occReport);
      if (result.status === 'applied') {
        seq += 1;
        flatEntries.push({
          cluster_id: decision.cluster_id || null, seq,
          op: result.op, occReport, status: 'applied',
        });
      }
    }
  }

  // Конфликты пересечений (после сбора ВСЕХ операций).
  resolveOverlaps(flatEntries);
  for (const entry of flatEntries) {
    if (entry.status === 'conflict') {
      entry.occReport.status = 'conflict';
      entry.occReport.reason = entry.reason;
    }
  }

  const ops = widenFullBlockDeletes(
    md,
    blocks || [],
    flatEntries.filter((e) => e.status === 'applied').map((e) => e.op),
  );
  const mdText = applyOps(md, ops);

  // Свёртка счётчиков по фактическим статусам вхождений.
  for (const perDec of report.perDecision) {
    for (const occ of perDec.occurrences) {
      if (occ.status === 'applied') report.applied += 1;
      else if (occ.status === 'skipped_occurrence') report.skipped += 1;
      else if (occ.status === 'conflict') report.conflicts += 1;
      else if (occ.status === 'failed') report.failed += 1;
      else if (occ.status === 'noop') report.noop += 1;
    }
  }

  return { mdText, report };
}

module.exports = {
  buildAgreedText,
  // для тестов
  findTolerant,
  uniqueOccurrences,
  normalizeForLocate,
};
