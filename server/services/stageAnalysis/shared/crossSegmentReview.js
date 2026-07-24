'use strict';

// Финальная МЕЖРАЗДЕЛЬНАЯ СВЕРКА находок стадии.
//
// Сегментный анализ видит документ по частям, поэтому после прогона всех
// сегментов нужен шаг, который смотрит на находки ЦЕЛИКОМ:
//   1) детерминированный дедуп «швов» — перекрытие сегментов даёт одно и то же
//      место ТЗ дважды (и как хвост части k, и как начало части k+1);
//   2) LLM-сверка между разделами — противоречия и повторы одной темы в разных
//      разделах, которые внутри одного сегмента не видны в принципе.
//
// Шаг (1) — чистый и обязательный. Шаг (2) — best-effort поверх него: сбой
// сверки не роняет стадию (находки уже добыты), а лишь отмечается в статистике.
// Отключается через STAGE_CROSS_SEGMENT_REVIEW=0.

const { chatJson } = require('../llm/openaiClient');

const CRIT_RANK = { critical: 4, high: 3, medium: 2, low: 1 };
// Сверх этого числа находок дайджест для модели становится дороже пользы —
// в LLM-сверку идут самые критичные, остальные остаются как есть (логируем).
const MAX_LLM_FINDINGS = Number(process.env.STAGE_CROSS_SEGMENT_MAX) || 200;
const MIN_FRAGMENT_FOR_CONTAINMENT = 24;

function isEnabled() {
  return String(process.env.STAGE_CROSS_SEGMENT_REVIEW || '1') !== '0';
}

function norm(s) {
  return (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function rankOf(c) {
  return CRIT_RANK[c] || 0;
}

// ── (1) Дедуп находок со «шва» сегментов (чистый) ────────────────────────────
// Дубль — это одна и та же цитата ТЗ с одним problem_type, пришедшая из разных
// сегментов (или из перекрытия). Кроме точного совпадения ловим вложенность:
// в одной части модель процитировала пункт целиком, в другой — его половину.
function mergeInto(primary, dup) {
  const segs = new Set([...(primary.segments || []), ...(dup.segments || [])]);
  primary.segments = [...segs].sort((a, b) => a - b);
  if (rankOf(dup.criticality) > rankOf(primary.criticality)) primary.criticality = dup.criticality;
  if ((dup.basis || '').length > (primary.basis || '').length) primary.basis = dup.basis;
  if (!primary.suggested_redaction && dup.suggested_redaction) {
    primary.suggested_redaction = dup.suggested_redaction;
  }
  if (!primary.review_comment && dup.review_comment) primary.review_comment = dup.review_comment;
  if (!primary.section_path && dup.section_path) primary.section_path = dup.section_path;
  primary.confidence = Math.max(Number(primary.confidence) || 0, Number(dup.confidence) || 0);
  primary.duplicate_count = (primary.duplicate_count || 1) + 1;
  return primary;
}

function dedupeAcrossSegments(findings) {
  const buckets = new Map();
  const kept = [];
  let mergedExact = 0;
  let mergedNested = 0;

  for (const raw of findings || []) {
    const f = { ...raw };
    f.segments = f.segments || (f.segment_index != null ? [f.segment_index] : []);
    const type = f.problem_type || '';
    const key = `${type}|${norm(f.fragment)}`;
    const exact = buckets.get(key);
    if (exact) {
      mergeInto(exact, f);
      mergedExact += 1;
      continue;
    }
    buckets.set(key, f);
    kept.push(f);
  }

  // Вложенность: длинные цитаты первыми, короткая-подстрока прилипает к длинной.
  const byType = new Map();
  for (const f of kept) {
    const t = f.problem_type || '';
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t).push(f);
  }
  const absorbed = new Set();
  for (const group of byType.values()) {
    const sorted = [...group].sort((a, b) => (b.fragment || '').length - (a.fragment || '').length);
    for (let i = 0; i < sorted.length; i += 1) {
      const long = sorted[i];
      if (absorbed.has(long)) continue;
      const ln = norm(long.fragment);
      if (ln.length < MIN_FRAGMENT_FOR_CONTAINMENT) continue;
      for (let j = i + 1; j < sorted.length; j += 1) {
        const short = sorted[j];
        if (absorbed.has(short)) continue;
        const sn = norm(short.fragment);
        if (sn.length < MIN_FRAGMENT_FOR_CONTAINMENT) continue;
        if (ln.indexOf(sn) === -1) continue;
        mergeInto(long, short);
        absorbed.add(short);
        mergedNested += 1;
      }
    }
  }

  const out = kept.filter((f) => !absorbed.has(f));
  return { findings: out, stats: { in: (findings || []).length, out: out.length, mergedExact, mergedNested } };
}

// ── (2) LLM-сверка между разделами ───────────────────────────────────────────
const RECONCILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    duplicates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['keep_id', 'drop_ids'],
        properties: {
          keep_id: { type: 'string', description: 'id находки, которую оставляем.' },
          drop_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'id находок про ТО ЖЕ место/требование ТЗ, которые надо убрать как повтор.',
          },
          reason: { type: 'string' },
        },
      },
    },
    cross_section: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['finding_ids', 'kind', 'comment'],
        properties: {
          finding_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'id находок из РАЗНЫХ разделов, связанных между собой.',
          },
          kind: {
            type: 'string',
            enum: ['contradiction', 'same_topic', 'escalate'],
            description:
              'contradiction — разделы требуют несовместимого; same_topic — одна тема в разных разделах; escalate — вместе они опаснее, чем поодиночке.',
          },
          comment: { type: 'string', description: 'Суть межраздельной связи (на русском, кратко).' },
          criticality: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
        },
      },
    },
  },
  required: ['duplicates', 'cross_section'],
};

const RECONCILE_SYSTEM = [
  'Ты — старший инженер тендерного отдела Генподрядчика. Текст ТЗ анализировался',
  'ПО ЧАСТЯМ (сегментам), и у тебя на руках сводка всех находок с указанием части',
  'и раздела. Твоя задача — ФИНАЛЬНАЯ МЕЖРАЗДЕЛЬНАЯ СВЕРКА. Новых замечаний по',
  'тексту НЕ придумывай — работай только с приведённым списком.',
  '',
  'Сделай две вещи:',
  '1) ПОВТОРЫ (duplicates): находки про ОДНО И ТО ЖЕ место/требование ТЗ, попавшие',
  '   в список несколько раз (обычно со стыка соседних частей — текст на границе',
  '   намеренно повторяется). Оставь самую полную (keep_id), остальные — drop_ids.',
  '   Разные требования одного раздела повторами НЕ считаются.',
  '2) МЕЖРАЗДЕЛЬНЫЕ СВЯЗИ (cross_section): находки из РАЗНЫХ разделов, которые',
  '   противоречат друг другу (contradiction), говорят об одной теме, разнесённой',
  '   по документу (same_topic), или вместе дают риск больше, чем поодиночке',
  '   (escalate). Это то, что не видно внутри одной части — ради этого шаг и нужен.',
  '',
  'Если повторов/связей нет — верни пустые массивы. Не выдумывай id: используй',
  'только те, что даны в списке. Верни JSON по схеме.',
].join('\n');

function digestFinding(f, id) {
  return {
    id,
    part: Array.isArray(f.segments) && f.segments.length ? f.segments.map((s) => s + 1) : null,
    section: f.section_path || '',
    problem_type: f.problem_type || '',
    criticality: f.criticality || '',
    fragment: (f.fragment || '').replace(/\s+/g, ' ').slice(0, 220),
    basis: (f.basis || '').replace(/\s+/g, ' ').slice(0, 220),
  };
}

function buildReconcileUserMessage({ findings, outline, ids }) {
  const digest = findings.map((f, i) => digestFinding(f, ids[i]));
  return [
    '## План документа (как он был нарезан на части)',
    '',
    '```json',
    JSON.stringify(outline || [], null, 2),
    '```',
    '',
    '## Находки всех частей',
    '',
    '```json',
    JSON.stringify(digest, null, 2),
    '```',
    '',
    '---',
    'Сведи находки между разделами: убери повторы одного места ТЗ (duplicates) и',
    'отметь межраздельные связи (cross_section). Верни JSON по схеме.',
  ].join('\n');
}

// Применение вердикта сверки к находкам (чистое). Удаляем только явные повторы;
// межраздельные связи не удаляют находку, а дописывают пометку инженеру и (для
// contradiction/escalate) могут ПОДНЯТЬ критичность — понизить не могут.
function applyReconciliation(findings, verdict, ids) {
  const byId = new Map();
  findings.forEach((f, i) => byId.set(ids[i], f));
  const dropped = new Set();
  let annotated = 0;

  for (const d of (verdict && verdict.duplicates) || []) {
    const keep = byId.get(d.keep_id);
    if (!keep) continue;
    for (const dropId of d.drop_ids || []) {
      const victim = byId.get(dropId);
      if (!victim || victim === keep || dropped.has(dropId)) continue;
      mergeInto(keep, victim);
      dropped.add(dropId);
    }
  }

  for (const g of (verdict && verdict.cross_section) || []) {
    const members = (g.finding_ids || []).map((id) => byId.get(id)).filter((f) => f && !dropped.has(f));
    if (members.length < 2) continue;
    const label = {
      contradiction: 'Межраздельная сверка (противоречие разделов)',
      same_topic: 'Межраздельная сверка (тема разнесена по разделам)',
      escalate: 'Межраздельная сверка (совокупный риск)',
    }[g.kind] || 'Межраздельная сверка';
    const note = `${label}: ${(g.comment || '').trim()}`;
    for (const m of members) {
      m.review_comment = m.review_comment ? `${m.review_comment} ${note}` : note;
      m.cross_section = { kind: g.kind, comment: g.comment || '' };
      if (g.criticality && rankOf(g.criticality) > rankOf(m.criticality)) m.criticality = g.criticality;
      annotated += 1;
    }
  }

  const out = findings.filter((f, i) => !dropped.has(ids[i]));
  return { findings: out, stats: { dropped: dropped.size, annotated, groups: ((verdict && verdict.cross_section) || []).length } };
}

// Полный шаг сверки: чистый дедуп (всегда) + LLM-сверка (best-effort).
async function reconcileFindings({ findings, outline, segments = 0, logTag = 'crossSegment' }) {
  const deduped = dedupeAcrossSegments(findings);
  const stats = { ...deduped.stats, llm: 'skipped', dropped: 0, annotated: 0, groups: 0 };
  let result = deduped.findings;

  const eligible = isEnabled() && segments > 1 && result.length >= 2;
  if (!eligible) {
    if (!isEnabled()) stats.llm = 'disabled';
    // eslint-disable-next-line no-console
    console.log(
      `[${logTag}] межраздельная сверка: дедуп ${deduped.stats.in}→${deduped.stats.out} ` +
        `(швы: точных ${deduped.stats.mergedExact}, вложенных ${deduped.stats.mergedNested}), LLM=${stats.llm}`,
    );
    return { findings: result, stats };
  }

  // В LLM-сверку идут самые критичные находки; остальные не теряются — они
  // просто не участвуют в этом шаге (о срезе сообщаем в логе и статистике).
  const ordered = [...result].sort((a, b) => rankOf(b.criticality) - rankOf(a.criticality));
  const subject = ordered.slice(0, MAX_LLM_FINDINGS);
  stats.llm_skipped_by_cap = ordered.length - subject.length;
  const ids = subject.map((_f, i) => `f${i + 1}`);

  try {
    const verdict = await chatJson({
      system: RECONCILE_SYSTEM,
      user: buildReconcileUserMessage({ findings: subject, outline, ids }),
      jsonSchema: RECONCILE_SCHEMA,
      schemaName: 'cross_segment_reconciliation',
    });
    const applied = applyReconciliation(subject, verdict, ids);
    const survived = new Set(applied.findings);
    result = result.filter((f) => !subject.includes(f) || survived.has(f));
    stats.llm = 'ok';
    stats.dropped = applied.stats.dropped;
    stats.annotated = applied.stats.annotated;
    stats.groups = applied.stats.groups;
  } catch (e) {
    stats.llm = 'failed';
    stats.error = e.message;
    // eslint-disable-next-line no-console
    console.warn(`[${logTag}] межраздельная сверка пропущена: ${e.message}`);
  }

  // eslint-disable-next-line no-console
  console.log(
    `[${logTag}] межраздельная сверка: дедуп ${deduped.stats.in}→${deduped.stats.out} ` +
      `(швы: точных ${deduped.stats.mergedExact}, вложенных ${deduped.stats.mergedNested}); ` +
      `LLM=${stats.llm} повторов-${stats.dropped} связей=${stats.groups} ` +
      `вне сверки(лимит)=${stats.llm_skipped_by_cap || 0} → итого ${result.length}`,
  );
  return { findings: result, stats };
}

module.exports = {
  RECONCILE_SCHEMA,
  RECONCILE_SYSTEM,
  isEnabled,
  dedupeAcrossSegments,
  buildReconcileUserMessage,
  applyReconciliation,
  reconcileFindings,
};
