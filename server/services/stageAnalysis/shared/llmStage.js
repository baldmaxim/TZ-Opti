'use strict';

// Общий LLM-каркас для стадий анализа (вынесено из stage1_llm.js).
// Generic: фильтр boilerplate-разделов → ИЕРАРХИЧЕСКАЯ token-aware сегментация
// ТЗ (shared/segmentation.js) → последовательный/волновой вызов chatJson по
// сегментам (fail-loud) с сохранением статуса и результата КАЖДОГО сегмента →
// финальная межраздельная сверка (shared/crossSegmentReview.js) → локализация
// фрагмента → расширение до ЦЕЛОГО ПУНКТА → Issue[].
//
// Стадия передаёт своё: systemMsg, schema, buildUserMessage(segment,i,n),
// tzBudget, riskCategory, issueDefaults, analysisNote, logTag. ВОР/чек-лист/
// Q&A-специфика остаётся в файле стадии.
//
// Ни одна стадия больше НЕ требует «весь ТЗ одним куском»: справочники
// (Q&A/характеристики/условия/риски) повторяются в каждом сегменте, а связи
// между разделами закрывает финальная сверка.

const crypto = require('crypto');
const { findInParagraphs } = require('./fragmentMatcher');
const { chatJson } = require('../llm/openaiClient');
const { coerceAction, ACTIONS } = require('../../analysis/actions');
const {
  normalizeImpactLevel,
  normalizeEvidenceLevel,
  normalizeDimensions,
  normalizeSuppressionFlags,
} = require('../../review/materiality');
const {
  segmentDocument,
  renderBlocks,
  renderSegmentText,
  outlineOf,
  charsToTokens,
  estimateTokens,
} = require('./segmentation');
const { reconcileFindings } = require('./crossSegmentReview');

const PER_BLOCK_OVERHEAD = 8; // заголовок-разметка + переводы строк

// Потолок ОДНОГО сегмента в токенах. Символьный бюджет стадии отвечает на
// вопрос «что влезет в контекст», этот — на вопрос «что модель реально
// проанализирует, ничего не потеряв в середине».
const SEGMENT_TOKENS = Number(process.env.STAGE_SEGMENT_TOKENS) || 20000;

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

// Рендер части ТЗ для промта. Принимает и сегмент (объект с заголовочным
// контекстом и перекрытием), и «сырой» массив блоков — стадии зовут одинаково.
function renderSegment(segmentOrBlocks) {
  if (Array.isArray(segmentOrBlocks)) return renderBlocks(segmentOrBlocks);
  return renderSegmentText(segmentOrBlocks);
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

// Нормализация enum-полей находки. Бридж теперь отдаёт best-effort (битый/
// неидеальный JSON не теряется), поэтому модель может вернуть свободное или
// иноязычное значение — приводим к словарю, иначе фильтры/экспорт сломаются.
const CRIT_SET = new Set(['critical', 'high', 'medium', 'low']);
function normalizeCriticality(v, fallback = 'medium') {
  if (typeof v !== 'string') return fallback;
  const s = v.trim().toLowerCase();
  if (CRIT_SET.has(s)) return s;
  if (/^(критич|critic|urgent|blocker|крит)/.test(s)) return 'critical';
  if (/^(выс|high|важн|серьёз|серьез)/.test(s)) return 'high';
  if (/^(сред|medium|med|умерен)/.test(s)) return 'medium';
  if (/^(низ|low|minor|незнач)/.test(s)) return 'low';
  return fallback;
}
// Нормализация действия — единый реестр (analysis/actions): точное значение,
// легаси-алиас (edit→replace) и фаззи-интерпретация свободного текста от LLM.
// Дефолт стадии (issueDefaults.suggestedAction) идёт как fallback.
function normalizeAction(v, fallback = ACTIONS.CLARIFY) {
  return coerceAction(v, fallback);
}

// Generic buildIssue: короткая цитата модели нужна, чтобы НАЙТИ место в тексте.
// ТОЧНЫЙ фрагмент (найденная цитата) + её char-диапазон В АБЗАЦЕ кладём в
// source_fragment/char_start/char_end, а ВЕСЬ абзац — отдельно в context_text.
// Раньше сюда клали весь абзац с диапазоном 0..len — и все находки одного абзаца
// получали ОДИН И ТОТ ЖЕ диапазон, из-за чего ниже (unifiedIssueBuilder) сливались
// в один draft_issue: несколько разных замечаний абзаца терялись. riskCategory и
// дефолты — параметры стадии. Поля risk_category/price_impact/schedule_impact
// модель может задать в находке — тогда они приоритетнее дефолтов стадии
// (Стадии 4/5 проставляют категорию/влияние по типу находки; Стадия 1 их не шлёт).
function buildIssue({ sourceDocumentId, finding, located, riskCategory, defaults = {} }) {
  const sectionPath =
    (finding.section_path || '').trim() ||
    (located?.block?.section_path?.join(' › ') || null);
  const blockText = located?.block?.text || null; // полный абзац — контекст
  const crit = normalizeCriticality(finding.criticality, 'medium');
  // Точная цитата: найденный в абзаце фрагмент (или сырая цитата модели, если
  // локализовать не удалось — безъякорный Issue стадий 2/3).
  const quote = located?.fragment || finding.fragment || null;
  return {
    source_document_id: sourceDocumentId || null,
    source_clause: located?.block ? `п. ${located.block.index + 1}` : null,
    source_fragment: quote || blockText || null,
    // Полный абзац сохраняем отдельно: нужен для показа/локализации и как фолбэк,
    // но НЕ как диапазон правки (иначе находки абзаца снова слипнутся).
    context_text: blockText,
    paragraph_index: located?.block?.index ?? null,
    char_start: located?.char_start ?? null,
    char_end: located?.char_end ?? null,
    problem_type: finding.problem_type || null,
    risk_category: finding.risk_category || riskCategory || null,
    criticality: crit,
    price_impact:
      finding.price_impact || (crit === 'high' || crit === 'critical' ? 'высокое' : 'возможно'),
    schedule_impact: finding.schedule_impact || 'возможно',
    basis: finding.basis || null,
    suggested_action: normalizeAction(
      finding.suggested_action || defaults.suggestedAction,
      defaults.suggestedAction,
    ),
    suggested_redaction: finding.suggested_redaction || null,
    review_comment: finding.review_comment || null,
    confidence:
      typeof finding.confidence === 'number'
        ? finding.confidence
        : (typeof defaults.confidence === 'number' ? defaults.confidence : 0.7),
    section_path: sectionPath || null,
    // Оценка МАТЕРИАЛЬНОСТИ, заявленная агентом (shared/materialityFields).
    // Нормализуем fail-closed, но НЕ подставляем дефолтов: «не заявлено» должно
    // остаться пустым, иначе сервер не отличит «агент промолчал» от «агент
    // сказал none». Итоговый вердикт считают unified/critic
    // (services/review/materiality.js) — criticality/confidence в него не входят.
    impact_level: normalizeImpactLevel(finding.impact_level, null),
    evidence_level: normalizeEvidenceLevel(finding.evidence_level, null),
    impact_dimensions: normalizeDimensions(finding.impact_dimensions),
    materiality_flags: normalizeSuppressionFlags(finding.materiality_flag),
  };
}

// Токенный бюджет одного сегмента: не больше того, что стадия готова отдать под
// текст ТЗ (символьный бюджет), и не больше потолка сегмента.
function resolveSegmentTokens(tzBudgetChars, override) {
  const cap = Math.max(500, Number(override) || SEGMENT_TOKENS);
  const fromChars = charsToTokens(tzBudgetChars);
  return Math.max(500, Math.min(cap, fromChars || cap));
}

const inputHashOf = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);

// ── Общий раннер LLM-стадии ──────────────────────────────────────────────────
// cfg = {
//   sourceDocumentId, systemMsg, schema, schemaName, tzBudget, concurrency,
//   buildUserMessage(segment, partIdx, partTotal) -> string | [{label, user}],
//   riskCategory, issueDefaults, analysisNote, logTag, locateBlocks?,
//   keepUnlocated?, mapFinding?, segmentTokens?, crossSegmentReview?,
//   combinePasses?
// }
// buildUserMessage может вернуть НЕСКОЛЬКО проходов на одну часть ТЗ (пакеты
//   справочника, который не влезает целиком, — большой ВОР у Стадии 1).
// combinePasses(lists, {segmentIndex, segment, passes}) (опц.) — как свести
//   находки проходов одной части; по умолчанию — объединение. Стадия 1 берёт
//   ПЕРЕСЕЧЕНИЕ: «нет в ВОР» верно, только если работы нет ни в одном пакете.
// locateBlocks (опц.) — по чему искать фрагмент (по умолчанию ctx.blocks).
// keepUnlocated (опц.) — не выбрасывать находки без фрагмента в ТЗ, эмитить
//   безъякорным Issue (Стадии 2/3: «не отражено», «нет ответа»).
// mapFinding (опц.) — нормализатор схемы стадии в стандартные поля находки до
//   сверки/локализации (Стадии 2/3: condition_name/status/qa_ref → fragment).
// segmentTokens (опц.) — свой потолок размера сегмента для стадии.
// ctx.segmentStore (опц.) — хранилище статуса/результата частей (analysis_segments).
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
  } = cfg;
  const blocks = ctx.blocks || [];
  const locateBlocks = cfg.locateBlocks || blocks;

  const analyzed = blocks.filter((b) => !isBoilerplateBlock(b));
  const droppedBoiler = blocks.length - analyzed.length;
  const budgetTokens = resolveSegmentTokens(tzBudget, cfg.segmentTokens);
  const { segments, stats } = segmentDocument(analyzed.length ? analyzed : blocks, { budgetTokens });
  // eslint-disable-next-line no-console
  console.log(
    `[${logTag}] blocks=${blocks.length} (boilerplate-=${droppedBoiler}) ` +
      `units=${stats.units} разбитых-блоков=${stats.splitBlocks} segments=${segments.length} ` +
      `бюджет=${budgetTokens}т перекрытие=${stats.overlapTokens}т ` +
      `макс.сегмент=${stats.maxSegmentTokens}т всего≈${stats.totalTokens}т concurrency=${concurrency} note=${!!analysisNote}`,
  );
  if (!segments.length) return [];

  // Сообщения строим заранее: их хэш — ключ кэша сегмента (и в хранилище, и в
  // чекпойнте задачи). Изменился текст ТЗ или справочник — хэш другой, часть
  // считается заново.
  //
  // buildUserMessage может вернуть НЕСКОЛЬКО сообщений (проходов) на одну часть
  // ТЗ — так стадия 1 показывает большой ВОР ПАКЕТАМИ вместо того, чтобы
  // выбросить его по лимиту. Проходы одной части идут последовательно, их
  // результаты сводит combinePasses; кэш части покрывает все её проходы разом.
  const prepared = segments.map((seg, idx) => {
    const built = buildUserMessage(seg, idx + 1, segments.length);
    const passes = (Array.isArray(built) ? built : [{ label: null, user: built }])
      .filter((p) => p && p.user);
    return {
      seg,
      idx,
      passes,
      hash: inputHashOf(passes.map((p) => p.user).join('\n---pass---\n')),
    };
  });

  // Режим planOnly (карта затронутого, impactService): посчитать нарезку и
  // хэши частей БЕЗ записи плана, без LLM и без истории. Результат уходит
  // side-channel'ом (ctx.planReport), возврат — пустой список находок, чтобы
  // обёртки стадий не менялись.
  if (ctx.planOnly) {
    ctx.planReport = {
      total: prepared.length,
      segments: prepared.map((p) => ({
        index: p.idx,
        key: p.seg.key || null,
        heading_path: (p.seg.headingPath || []).join(' › ') || null,
        chars: p.seg.chars ?? null,
        tokens: p.seg.tokens ?? null,
        input_hash: p.hash,
      })),
    };
    return [];
  }

  // План нарезки в analysis_segments: статус каждой части виден снаружи и
  // переживает завершение задания (в отличие от чекпойнта задачи).
  const store = ctx.segmentStore || null;
  if (store) {
    await store.plan(prepared.map((p) => ({
      index: p.idx,
      key: p.seg.key,
      headingPath: p.seg.headingPath,
      firstBlockIndex: p.seg.firstBlockIndex,
      lastBlockIndex: p.seg.lastBlockIndex,
      chars: p.seg.chars,
      tokens: p.seg.tokens,
      inputHash: p.hash,
    })));
  }

  // Прогресс по сегментам для круговой шкалы. Репортер пишет в строку задачи
  // очереди (analysis_tasks) — прогресс переживает рестарт и виден из любого
  // процесса. Без очереди (синхронный вызов) ctx.progress отсутствует.
  await ctx.progress?.setTotal(segments.length);

  // Мост к задаче очереди (опц.): чекпойнт по сегментам + кооперативная отмена.
  const control = ctx.jobControl || null;

  // Проходы одной части ТЗ (пакеты справочника) — последовательно, результат
  // сводит combinePasses (по умолчанию — простое объединение).
  const combinePasses = cfg.combinePasses || ((lists) => lists.flat());
  async function runPasses(item) {
    const lists = [];
    for (const pass of item.passes) {
      // eslint-disable-next-line no-await-in-loop
      const json = await chatJson({ system: systemMsg, user: pass.user, jsonSchema: schema, schemaName });
      const list = Array.isArray(json?.findings) ? json.findings : [];
      if (item.passes.length > 1) {
        // eslint-disable-next-line no-console
        console.log(
          `[${logTag}] часть ${item.idx + 1}/${segments.length}, проход ` +
            `${pass.label || `${lists.length + 1}/${item.passes.length}`}: findings=${list.length}`,
        );
      }
      lists.push(list);
    }
    return combinePasses(lists, { segmentIndex: item.idx, segment: item.seg, passes: item.passes });
  }

  const startedAt = Date.now();
  const results = new Array(segments.length);
  let reused = 0;
  for (let start = 0; start < prepared.length; start += concurrency) {
    control?.guard?.(); // отмена задания — прерываемся между волнами
    const wave = [];
    for (let i = start; i < Math.min(start + concurrency, prepared.length); i += 1) {
      const { idx, hash } = prepared[i];
      // Кэш части: сначала долговременное хранилище (кэш ревизии), затем
      // чекпойнт задачи. Источник важен для истории прогона: часть, поднятая из
      // кэша, засчитана, но модели НЕ показывалась — в analysis_run_segments это
      // видно как source='cache'/'checkpoint', а не как выполненный расчёт.
      // eslint-disable-next-line no-await-in-loop
      const fromStore = store ? await store.getCompleted(idx, hash) : null;
      const cached = fromStore || control?.getSegment?.(idx, hash) || null;
      if (cached) {
        results[idx] = cached;
        reused += 1;
        wave.push(
          Promise.resolve(store?.markReused(idx, cached.length, fromStore ? 'cache' : 'checkpoint'))
            .then(() => ctx.progress?.tick()),
        );
        continue;
      }
      wave.push(
        Promise.resolve(store?.markRunning(idx))
          .then(() => runPasses(prepared[i]))
          .then(async (segFindings) => {
            // eslint-disable-next-line no-console
            console.log(
              `[${logTag}] часть ${idx + 1}/${segments.length} ` +
                `(${(prepared[i].seg.headingPath || []).join(' › ') || '—'}): findings=${segFindings.length}`,
            );
            results[idx] = segFindings;
            // Сначала чекпойнт (чтобы повтор не потерял сегмент), потом прогресс.
            await store?.saveSuccess(idx, segFindings);
            await control?.saveSegment?.(idx, hash, segFindings);
            await ctx.progress?.tick(); // +1 сегмент готов → круговая шкала
          })
          .catch(async (e) => {
            await store?.saveFailure(idx, e);
            const err = new Error(
              `Стадия: часть ${idx + 1}/${segments.length} — ${e.message}`,
            );
            err.status = e.status || 502;
            err.cause = e;
            err.segmentIndex = idx;
            throw err;
          }),
      );
    }
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(wave);
  }
  if (reused) {
    // eslint-disable-next-line no-console
    console.log(`[${logTag}] продолжение с сохранённых частей: переиспользовано ${reused}/${segments.length}`);
  }

  // Нормализуем схему стадии в стандартную находку (Стадии 2/3/4) и помечаем,
  // из какой части ТЗ она пришла, — провенанс нужен межраздельной сверке.
  const mapped = [];
  results.forEach((arr, idx) => {
    for (const raw of arr || []) {
      // idx вторым аргументом: стадии с побочным учётом (матрица покрытия
      // Стадии 3) знают, из какой части ТЗ пришла находка.
      const m = mapFinding ? mapFinding(raw, idx) : { ...raw };
      if (!m) continue;
      m.segments = [idx];
      mapped.push(m);
    }
  });
  // eslint-disable-next-line no-console
  console.log(
    `[${logTag}] все ${segments.length} частей за ${Date.now() - startedAt}ms, findings(сырых)=${mapped.length}`,
  );

  // Финальная межраздельная сверка: дедуп швов (перекрытие) + связи между
  // разделами. Дедуп чистый и обязательный, LLM-часть best-effort.
  const reconciled = await reconcileFindings({
    findings: mapped,
    outline: outlineOf(segments),
    segments: segments.length,
    logTag,
  });
  const findings = reconciled.findings;

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
  // Сводка нарезки — уходит в summary прогона стадии (видно инженеру).
  issues.segmentation = {
    segments: segments.length,
    reused,
    budget_tokens: budgetTokens,
    overlap_tokens: stats.overlapTokens,
    max_segment_tokens: stats.maxSegmentTokens,
    total_tokens: stats.totalTokens,
    split_blocks: stats.splitBlocks,
    reconciliation: reconciled.stats,
  };
  return issues;
}

module.exports = {
  PER_BLOCK_OVERHEAD,
  SEGMENT_TOKENS,
  BOILERPLATE_HEADING,
  isBoilerplateBlock,
  renderSegment,
  segmentDocument,
  estimateTokens,
  resolveSegmentTokens,
  normalizeForLocate,
  locateInBlocks,
  buildIssue,
  runLlmStage,
};
