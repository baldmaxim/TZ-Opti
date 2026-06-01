'use strict';

// Общий LLM-каркас для стадий анализа (вынесено из stage1_llm.js).
// Generic: фильтр boilerplate-разделов → сегментация ТЗ под бюджет →
// последовательный/волновой вызов chatJson по сегментам (fail-loud) →
// дедуп → локализация фрагмента → расширение до ЦЕЛОГО ПУНКТА → Issue[].
//
// Стадия передаёт своё: systemMsg, schema, buildUserMessage(segBlocks,i,n),
// tzBudget, riskCategory, issueDefaults, analysisNote, logTag. ВОР/чек-лист/
// Q&A-специфика остаётся в файле стадии.

const { findInParagraphs } = require('./fragmentMatcher');
const { chatJson } = require('../llm/openaiClient');

const PER_BLOCK_OVERHEAD = 8; // заголовок-разметка + переводы строк

// Стандартные НЕ-рабочие разделы ТЗ (термины, сокращения, нормативные
// ссылки, реквизиты, оглавление) — никогда не флагаются, не шлём их в LLM.
const BOILERPLATE_HEADING =
  /^\s*(?:\d+[.\d\s]*)?(термины и определения|определения и сокращения|термины,?\s*определения и сокращения|(?:список|перечень|обозначения и)\s+сокращени\w*|нормативн\w+\s+(?:ссылк\w+|документ\w+)|перечень нормативн\w+|реквизиты сторон|(?:юридические )?адреса и реквизиты|содержание|оглавление)\s*$/i;

function isBoilerplateBlock(b) {
  if (b && b.type === 'heading' && BOILERPLATE_HEADING.test(b.text || '')) {
    return true;
  }
  const sp = (b && b.section_path) || [];
  return sp.some((h) => BOILERPLATE_HEADING.test(h || ''));
}

// Рендер сегмента: заголовки как markdown (#), прочее — дословный block.text
// (fragment в ответе модели должен дословно совпасть — нужно locateInBlocks).
function renderSegment(segBlocks) {
  const parts = [];
  for (const b of segBlocks) {
    if (b.type === 'heading') {
      parts.push(`${'#'.repeat(Math.max(1, b.level || 1))} ${b.text}`);
    } else {
      parts.push(b.text);
    }
  }
  return parts.join('\n');
}

// Жадная упаковка блоков в сегменты под tzBudget. Блок крупнее бюджета —
// собственный сегмент (дробить нельзя без потери дословности).
function segmentBlocks(blocks, tzBudget, perBlockOverhead = PER_BLOCK_OVERHEAD) {
  const segments = [];
  let cur = [];
  let curLen = 0;
  for (const b of blocks) {
    const blockLen = (b.text || '').length + perBlockOverhead;
    if (cur.length && curLen + blockLen > tzBudget) {
      segments.push(cur);
      cur = [];
      curLen = 0;
    }
    cur.push(b);
    curLen += blockLen;
  }
  if (cur.length) segments.push(cur);
  return segments;
}

// Грубая нормализация для substring-локализации фрагмента в блоках.
function normalizeForLocate(s) {
  return (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function locateInBlocks(blocks, fragment) {
  const ndl = normalizeForLocate(fragment);
  if (!ndl) return null;
  for (const block of blocks) {
    const haystackNorm = normalizeForLocate(block.text);
    if (haystackNorm.indexOf(ndl) === -1) continue;
    const hits = findInParagraphs([block], fragment);
    if (hits.length) {
      const hit = hits[0];
      return { block, char_start: hit.char_start, char_end: hit.char_end, fragment: hit.fragment };
    }
    return {
      block,
      char_start: 0,
      char_end: Math.min(block.text.length, fragment.length),
      fragment: block.text.slice(0, Math.min(block.text.length, fragment.length)),
    };
  }
  return null;
}

// Generic buildIssue: короткая цитата модели нужна лишь чтобы НАЙТИ пункт;
// в замечание кладём ВЕСЬ пункт (блок = пункт/абзац) + char-диапазон на
// весь пункт (экспорт метит пункт целиком). riskCategory и дефолты —
// параметры стадии. Поля risk_category/price_impact/schedule_impact модель
// может задать в находке — тогда они приоритетнее дефолтов стадии (Стадии 4/5
// проставляют категорию/влияние по типу находки; Стадия 1 их не шлёт →
// прежнее поведение).
function buildIssue({ sourceDocumentId, finding, located, riskCategory, defaults = {} }) {
  const sectionPath =
    (finding.section_path || '').trim() ||
    (located?.block?.section_path?.join(' › ') || null);
  const blockText = located?.block?.text || null;
  return {
    source_document_id: sourceDocumentId || null,
    source_clause: located?.block ? `п. ${located.block.index + 1}` : null,
    source_fragment: blockText || located?.fragment || finding.fragment || null,
    paragraph_index: located?.block?.index ?? null,
    char_start: blockText ? 0 : (located?.char_start ?? null),
    char_end: blockText ? blockText.length : (located?.char_end ?? null),
    problem_type: finding.problem_type || null,
    risk_category: finding.risk_category || riskCategory || null,
    criticality: finding.criticality || 'medium',
    price_impact:
      finding.price_impact || (finding.criticality === 'high' ? 'высокое' : 'возможно'),
    schedule_impact: finding.schedule_impact || 'возможно',
    basis: finding.basis || null,
    suggested_action: finding.suggested_action || defaults.suggestedAction || 'clarify',
    suggested_redaction: finding.suggested_redaction || null,
    review_comment: finding.review_comment || null,
    confidence:
      typeof finding.confidence === 'number'
        ? finding.confidence
        : (typeof defaults.confidence === 'number' ? defaults.confidence : 0.7),
    section_path: sectionPath || null,
  };
}

function dedupe(findings) {
  const seen = new Set();
  const out = [];
  for (const f of findings) {
    const key = `${(f.fragment || '').trim()}|${(f.section_path || '').trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

// ── Общий раннер LLM-стадии ──────────────────────────────────────────────────
// cfg = {
//   sourceDocumentId, systemMsg, schema, schemaName, tzBudget, concurrency,
//   buildUserMessage(segBlocks, partIdx, partTotal) -> string,
//   riskCategory, issueDefaults, analysisNote, logTag, locateBlocks?,
//   keepUnlocated?, mapFinding?, requireSingleSegment?
// }
// locateBlocks (опц.) — по чему искать фрагмент (по умолчанию ctx.blocks).
// keepUnlocated (опц.) — не выбрасывать находки без фрагмента в ТЗ, эмитить
//   безъякорным Issue (Стадии 2/3: «не отражено», «нет ответа»).
// mapFinding (опц.) — нормализатор схемы стадии в стандартные поля находки до
//   локализации/buildIssue (Стадии 2/3: condition_name/status/qa_ref → fragment).
// requireSingleSegment (опц.) — для стадий, которым нужен ВЕСЬ ТЗ в одном
//   контексте (2/3): если ТЗ разбился на >1 сегмент — понятная ошибка.
async function runLlmStage(ctx, cfg) {
  const {
    sourceDocumentId,
    systemMsg,
    schema,
    schemaName,
    tzBudget,
    concurrency = 1,
    buildUserMessage,
    riskCategory = null,
    issueDefaults = {},
    analysisNote = null,
    logTag = 'llmStage',
    keepUnlocated = false,
    mapFinding = null,
    requireSingleSegment = false,
  } = cfg;
  const blocks = ctx.blocks || [];
  const locateBlocks = cfg.locateBlocks || blocks;

  const analyzed = blocks.filter((b) => !isBoilerplateBlock(b));
  const droppedBoiler = blocks.length - analyzed.length;
  const segments = segmentBlocks(analyzed.length ? analyzed : blocks, tzBudget);
  // eslint-disable-next-line no-console
  console.log(
    `[${logTag}] blocks=${blocks.length} (boilerplate-=${droppedBoiler}) segments=${segments.length} concurrency=${concurrency} tzBudget=${tzBudget}ch note=${!!analysisNote}`,
  );

  if (requireSingleSegment && segments.length > 1) {
    const err = new Error(
      `ТЗ слишком большое для этой стадии: его нужно анализировать целиком ` +
        `(${segments.length} сегментов > 1, бюджет ${tzBudget} симв). ` +
        `Сократите ТЗ.md или увеличьте бюджет контекста.`,
    );
    err.status = 400;
    throw err;
  }

  const startedAt = Date.now();
  const results = new Array(segments.length);
  for (let start = 0; start < segments.length; start += concurrency) {
    const wave = [];
    for (let i = start; i < Math.min(start + concurrency, segments.length); i += 1) {
      const idx = i;
      const userMsg = buildUserMessage(segments[idx], idx + 1, segments.length);
      wave.push(
        chatJson({ system: systemMsg, user: userMsg, jsonSchema: schema, schemaName })
          .then((json) => {
            const segFindings = Array.isArray(json?.findings) ? json.findings : [];
            // eslint-disable-next-line no-console
            console.log(
              `[${logTag}] часть ${idx + 1}/${segments.length}: findings=${segFindings.length}`,
            );
            results[idx] = segFindings;
          })
          .catch((e) => {
            const err = new Error(
              `Стадия: часть ${idx + 1}/${segments.length} — ${e.message}`,
            );
            err.status = e.status || 502;
            err.cause = e;
            throw err;
          }),
      );
    }
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(wave);
  }
  const allFindings = [];
  for (const r of results) if (r) allFindings.push(...r);
  // eslint-disable-next-line no-console
  console.log(
    `[${logTag}] все ${segments.length} частей за ${Date.now() - startedAt}ms, findings(сырых)=${allFindings.length}`,
  );

  // Нормализуем схему стадии в стандартную находку (Стадии 2/3) до дедупа —
  // дедуп завязан на f.fragment/f.section_path.
  const mapped = mapFinding
    ? allFindings.map((f) => mapFinding(f)).filter(Boolean)
    : allFindings;
  const findings = dedupe(mapped);
  const issues = [];
  let dropped = 0;
  for (const f of findings) {
    const located = locateInBlocks(locateBlocks, f.fragment);
    if (!located && !keepUnlocated) {
      dropped += 1;
      // eslint-disable-next-line no-console
      console.warn(
        `[${logTag}] dropped finding (fragment not located): ${JSON.stringify(f.fragment).slice(0, 120)}`,
      );
      continue;
    }
    // keepUnlocated: located=null → безъякорный Issue (buildIssue это умеет).
    issues.push(buildIssue({ sourceDocumentId, finding: f, located, riskCategory, defaults: issueDefaults }));
  }
  if (dropped) {
    // eslint-disable-next-line no-console
    console.log(`[${logTag}] dropped ${dropped} findings out of ${findings.length}`);
  }
  if (analysisNote) issues.analysisNote = analysisNote;
  return issues;
}

module.exports = {
  PER_BLOCK_OVERHEAD,
  BOILERPLATE_HEADING,
  isBoilerplateBlock,
  renderSegment,
  segmentBlocks,
  normalizeForLocate,
  locateInBlocks,
  buildIssue,
  dedupe,
  runLlmStage,
};
