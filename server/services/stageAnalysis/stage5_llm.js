'use strict';

// Стадия 5 (QC) — LLM-агент качества итога. Вход — исходный ТЗ + готовые
// КЛАСТЕРЫ замечаний. Агент проверяет ТОЛЬКО качество существующих кластеров:
//   weak_cluster · no_consequence · needs_enrichment · duplicate_cluster ·
//   cluster_contradiction · overstated_criticality.
// Пропуски разбора ищет ОТДЕЛЬНЫЙ challenger-агент (stage5Challenger) — здесь
// их нет по определению (прежнее противоречие «не ищи заново, но найди
// пропущенное» снято).
//
// Здесь только Stage-5-специфика LLM-вызова: схема ответа, сериализация входа,
// прогон модели ПО ЧАСТЯМ ТЗ (той же иерархической сегментацией, что и стадии
// 1–4 — усечения текста больше нет). Оркестрация (загрузка кластеров/сигналов/ТЗ,
// эвристики, запись self_analysis_results) — в selfAnalysis/selfAnalysisService.js.
// Промт (роль QC + 4 вопроса + режимы) — в stage5Prompts.js.

const crypto = require('crypto');
const { chatJson, getModel, isConfigured } = require('./llm/openaiClient');
const { buildSystemPrompt, resolveVariant } = require('./stage5Prompts');
const { segmentDocument, renderSegmentText, charsToTokens } = require('./shared/segmentation');
const { STATUS } = require('../analysis/resultStatus');

const hashOf = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);

// Типы, которые выдаёт LLM-QC: только КАЧЕСТВО существующих кластеров
// (основание / последствие / рекомендация / дубль / конфликт / критичность).
// Пропуски (missed_coverage) LLM-QC больше НЕ ищет — это работа независимого
// challenger-агента (stage5Challenger), чьи находки становятся обычными
// замечаниями. missed_coverage остаётся ТОЛЬКО у детерминированной эвристики
// (категории сигналов, потерянные при сборке, — selfAnalysisService).
const LLM_FINDING_TYPES = [
  'weak_cluster',
  'no_consequence',
  'needs_enrichment',
  'duplicate_cluster',
  'cluster_contradiction',
  'overstated_criticality',
];
const FINDING_TYPES = ['missed_coverage', ...LLM_FINDING_TYPES];

// Исход LLM-шага QC. Три первых — общий контракт результата (resultStatus):
// completed (все части ТЗ посчитаны) · completed_with_warnings (часть упала) ·
// failed (не посчитана НИ ОДНА часть, хотя QC был запрошен). Плюс два исхода
// «QC не запускался» — их НЕЛЬЗЯ путать со сбоем:
//   not_applicable — кластеров нет, проверять нечего;
//   skipped        — LLM не настроен (нет ключа), обогащение не выполнялось.
const QC_STATUS = Object.freeze({
  COMPLETED: STATUS.COMPLETED,
  COMPLETED_WITH_WARNINGS: STATUS.COMPLETED_WITH_WARNINGS,
  FAILED: STATUS.FAILED,
  NOT_APPLICABLE: 'not_applicable',
  SKIPPED: 'skipped',
});

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['finding_type', 'cluster_id', 'comment', 'suggested_improvement', 'confidence'],
        properties: {
          finding_type: { type: 'string', enum: LLM_FINDING_TYPES },
          cluster_id: {
            type: 'string',
            description:
              'ОБЯЗАТЕЛЬНО: точный id кластера из переданного списка, к которому относится вывод. ' +
              'Вывод без валидного cluster_id отбрасывается.',
          },
          comment: { type: 'string', description: 'Что именно не так с разбором (на русском).' },
          suggested_improvement: {
            type: 'string',
            description: 'Как улучшить итог: чем дополнить кластер / что добавить в разбор.',
          },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
  },
  required: ['findings'],
};

// QC идёт ПО ЧАСТЯМ ТЗ, а не по усечённому «первому куску».
// Раньше здесь стоял TZ_CHAR_BUDGET=200000 и хвост документа просто отрезался
// («…(текст ТЗ усечён)») — на больших ТЗ пропуски искались по началу файла, а
// про конец агент не знал ничего. Теперь текст режется той же иерархической
// сегментацией, что и стадии 1–4, и каждая часть проверяется отдельно (кластеры
// компактны и повторяются в каждой части целиком).
const SEGMENT_TOKENS = Number(process.env.STAGE5_SEGMENT_TOKENS)
  || (process.env.STAGE5_TZ_BUDGET ? charsToTokens(Number(process.env.STAGE5_TZ_BUDGET)) : 0)
  || Number(process.env.STAGE_SEGMENT_TOKENS)
  || 20000;

// Компактный дайджест кластера для модели (без шумных полей).
function digestCluster(c) {
  return {
    cluster_id: c.id,
    tz_clause: c.tz_clause || '',
    title: c.cluster_title || '',
    criticality: c.overall_criticality || '',
    problem_type: c.final_problem_type || '',
    semantic_bucket: c.semantic_bucket || '',
    item_count: c.item_count || (Array.isArray(c.items) ? c.items.length : 0),
    basis: c.merged_basis || '',
    recommendation: c.merged_recommendation || '',
  };
}

function buildSelfAnalysisUserMessage({ tzText, clusters, signalStats, partIdx = 1, partTotal = 1 }) {
  const digest = (clusters || []).map(digestCluster);
  const tz = (tzText || '').trim();
  const tzHeader =
    partTotal > 1
      ? `## Исходный ТЗ — часть ${partIdx}/${partTotal} (markdown)\n\n` +
        '> Кластеры выше — по ВСЕМУ документу; ниже — ЭТА часть ТЗ. Оценивай полноту\n' +
        '> разбора по приведённой части: остальные части проверяются отдельно, поэтому\n' +
        '> не пиши «пропущено» про то, чего в этой части нет.'
      : '## Исходный ТЗ (markdown)';
  return [
    '## Кластеры замечаний (итог конвейера) — JSON',
    '',
    '```json',
    JSON.stringify(digest, null, 2),
    '```',
    '',
    '## Статистика сигналов',
    '',
    '```json',
    JSON.stringify(signalStats || {}, null, 2),
    '```',
    '',
    tzHeader,
    '',
    tz || '(пусто)',
    '',
    '---',
    'Проверь КАЧЕСТВО разбора (пропуски НЕ ищи — это работа challenger-агента):',
    'слабое основание (weak_cluster), нет последствия (no_consequence),',
    'неконкретная рекомендация (needs_enrichment), дубли (duplicate_cluster),',
    'конфликтующие рекомендации (cluster_contradiction), завышенная критичность',
    '(overstated_criticality). cluster_id — точный id из списка выше, обязателен.',
    'Верни JSON по схеме (поле findings).',
  ].join('\n');
}

// Нарезка ТЗ для QC. Основной вход — блоки (иерархия заголовков/пунктов);
// если доступен только плоский текст, заворачиваем его в один блок — дробление
// слишком большого блока внутри сегментации всё равно разложит его на части.
function segmentsForQc({ tzBlocks, tzText, budgetTokens = SEGMENT_TOKENS }) {
  const blocks = Array.isArray(tzBlocks) && tzBlocks.length
    ? tzBlocks
    : ((tzText || '').trim()
      ? [{ index: 0, type: 'paragraph', text: String(tzText), section_path: [] }]
      : []);
  if (!blocks.length) return [];
  return segmentDocument(blocks, { budgetTokens }).segments;
}

// Дедуп находок QC между частями: один и тот же дефект разбора может быть виден
// из нескольких частей ТЗ (особенно на перекрытии).
function dedupeQcFindings(findings) {
  const seen = new Set();
  const out = [];
  for (const f of findings) {
    const key = `${f && f.finding_type}|${(f && f.cluster_id) || ''}|` +
      `${String((f && f.comment) || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

// Пустой (ничего не считали) исход QC — общая форма ответа.
function qcOutcome(status, { findings = [], segmentation = null, reason = null } = {}) {
  return { status, findings, segmentation, reason };
}

// Прогон QC по частям ТЗ. Возвращает ИСХОД `{ status, findings, segmentation,
// reason }` (нормализацию/привязку к cluster_id и запись делает
// selfAnalysisService). Функция НЕ бросает: исход «не посчиталось» — это
// status=failed, а не исключение, чтобы вызывающий не мог принять его за
// «LLM недоступен → идём на эвристиках» (ложный успех).
// segmentStore (опц.) — то же хранилище статуса/результата частей, что у стадий
// 1–4: часть, посчитанная раньше, не переспрашивается, а упавшую можно
// перезапустить точечно.
async function runSelfAnalysisLlm({
  tzText, tzBlocks, clusters, signalStats, segmentStore = null, budgetTokens, llmConfigured,
}) {
  // Кластеров нет — QC-проверять нечего. Это НЕ сбой: слой явно неприменим.
  if (!Array.isArray(clusters) || !clusters.length) {
    return qcOutcome(QC_STATUS.NOT_APPLICABLE, { reason: 'кластеров нет — QC-проверять нечего' });
  }
  // LLM не настроен — QC не запрашивался в принципе (обогащения не будет).
  // Явный skipped, а не «упало»: эвристики выше остаются в силе.
  const configured = llmConfigured != null ? Boolean(llmConfigured) : isConfigured();
  if (!configured) {
    return qcOutcome(QC_STATUS.SKIPPED, {
      reason: 'LLM не настроен (OPENAI_API_KEY) — QC-обогащение не выполнялось',
    });
  }
  const variant = resolveVariant();
  const system = buildSystemPrompt(variant);
  const segments = segmentsForQc({ tzBlocks, tzText, budgetTokens: budgetTokens || SEGMENT_TOKENS });
  const total = Math.max(1, segments.length);
  // eslint-disable-next-line no-console
  console.log(
    `[stage5_self_analysis] model=${getModel()} promptVariant=${variant} ` +
      `clusters=${clusters.length} частей ТЗ=${total} бюджет=${budgetTokens || SEGMENT_TOKENS}т`,
  );

  const prepared = (segments.length ? segments : [null]).map((seg, idx) => ({
    idx,
    seg,
    user: buildSelfAnalysisUserMessage({
      tzText: seg ? renderSegmentText(seg) : '',
      clusters,
      signalStats,
      partIdx: idx + 1,
      partTotal: total,
    }),
  }));

  if (segmentStore) {
    await segmentStore.plan(prepared.map((p) => ({
      index: p.idx,
      key: p.seg ? p.seg.key : 'seg_empty',
      headingPath: p.seg ? p.seg.headingPath : [],
      firstBlockIndex: p.seg ? p.seg.firstBlockIndex : null,
      lastBlockIndex: p.seg ? p.seg.lastBlockIndex : null,
      chars: p.seg ? p.seg.chars : 0,
      tokens: p.seg ? p.seg.tokens : 0,
      inputHash: hashOf(p.user),
    })));
  }

  // QC — слой качества поверх готового итога, поэтому упавшая часть НЕ обнуляет
  // остальные: собираем всё, что посчиталось, и сообщаем о провалившихся частях
  // (их статус лежит в analysis_segments — часть можно пересчитать точечно).
  // Если не досчиталась НИ ОДНА часть — исход failed (см. ниже), пригодного
  // результата QC нет.
  const all = [];
  const failed = [];
  for (const p of prepared) {
    const hash = hashOf(p.user);
    // eslint-disable-next-line no-await-in-loop
    const cached = segmentStore ? await segmentStore.getCompleted(p.idx, hash) : null;
    if (cached) {
      all.push(...cached);
      // Часть засчитана из кэша ревизии — в истории прогона это отдельный
      // source, а не «модель отработала».
      // eslint-disable-next-line no-await-in-loop
      await segmentStore?.markReused(p.idx, cached.length, 'cache');
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await segmentStore?.markRunning(p.idx);
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await chatJson({
        system,
        user: p.user,
        jsonSchema: RESPONSE_SCHEMA,
        schemaName: 'stage5_self_analysis',
      });
      const findings = Array.isArray(res && res.findings) ? res.findings : [];
      all.push(...findings);
      // eslint-disable-next-line no-await-in-loop
      await segmentStore?.saveSuccess(p.idx, findings);
    } catch (e) {
      failed.push({ part: p.idx + 1, error: e.message });
      // eslint-disable-next-line no-await-in-loop
      await segmentStore?.saveFailure(p.idx, e);
      // eslint-disable-next-line no-console
      console.warn(`[stage5_self_analysis] часть ${p.idx + 1}/${total} не досчитана: ${e.message}`);
    }
  }
  const out = dedupeQcFindings(all);
  const segmentation = {
    segments: total,
    completed_parts: total - failed.length,
    failed_parts: failed.length ? failed : null,
    findings_raw: all.length,
    findings: out.length,
  };

  // 0 из N — QC был запрошен и не дал ничего: сбой слоя, не «пропуск обогащения».
  if (failed.length === total) {
    return qcOutcome(QC_STATUS.FAILED, {
      segmentation,
      reason: `не досчитана ни одна часть ТЗ (${total}) — ${failed[0].error}`,
    });
  }
  // 1..N-1 из N — частичный результат: пригоден, но не полон.
  if (failed.length) {
    return qcOutcome(QC_STATUS.COMPLETED_WITH_WARNINGS, {
      findings: out,
      segmentation,
      reason: `не досчитано частей ТЗ: ${failed.length} из ${total}`,
    });
  }
  return qcOutcome(QC_STATUS.COMPLETED, { findings: out, segmentation });
}

module.exports = {
  FINDING_TYPES,
  LLM_FINDING_TYPES,
  QC_STATUS,
  RESPONSE_SCHEMA,
  SEGMENT_TOKENS,
  digestCluster,
  buildSelfAnalysisUserMessage,
  segmentsForQc,
  dedupeQcFindings,
  runSelfAnalysisLlm,
};
