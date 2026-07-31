'use strict';

// Стадия 3 — LLM-агент: ТЗ vs существенные условия компании + ПОКРЫТИЕ.
// ОСНОВА — условия компании (источник истины) и темы покрытия
// (conditionCoverage.COVERAGE_TOPICS). По каждой ЗАТРОНУТОЙ в части ТЗ теме
// агент выставляет статус:
//   противоречит   → ТЗ говорит несовместимое (Issue с цитатой ТЗ)
//   соответствует  → тема есть и не противоречит (идёт в матрицу покрытия)
//   неоднозначно   → тема затронута, но сформулирована двусмысленно (Issue)
// Тему, не затронутую в части, агент НЕ возвращает — «отсутствует» считается
// только агрегацией по ВСЕМ частям (пересечение, как «нет в ВОР» у Стадии 1):
// тема, не затронутая нигде, становится БЕЗЪЯКОРНОЙ находкой
// «условие_отсутствует» с правильным действием (запрос Заказчику / допущение /
// условие КП / проверка договора / резерв риска), а не требованием править
// текст. Матрица покрытия пишется в condition_coverage (coverageService).
// Большое ТЗ сверяется ЧАСТЯМИ (иерархическая сегментация): справочник
// повторяется в каждой части; повторы со стыков снимает межраздельная сверка
// (shared/crossSegmentReview.js). Промт — в stage3Prompts.js.
// Контракт: (context) → Issue[]

const db = require('../../db/connection');
const { getModel } = require('./llm/openaiClient');
const { buildSystemPrompt, resolveVariant } = require('./stage3Prompts');
const {
  defaultsFor,
  renderConditions,
  tenderTypeToContractKind,
} = require('../conditionsRenderer');
const { renderSegment, runLlmStage, buildIssue, locateInBlocks } = require('./shared/llmStage');
const { attachMateriality } = require('./shared/materialityFields');
const {
  buildTopicList,
  aggregateCoverage,
  buildMissingFinding,
  selectMissingTopics,
  normalizePartStatus,
  PART_STATUS,
} = require('./conditionCoverage');
const coverageService = require('../conditions/coverageService');

const RESPONSE_SCHEMA = attachMateriality({
  type: 'object',
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['condition_name', 'status', 'fragment', 'section_path', 'basis', 'confidence'],
        properties: {
          condition_name: {
            type: 'string',
            description: 'Наименование условия или темы из справочника (скопируй дословно).',
          },
          status: {
            type: 'string',
            enum: ['противоречит', 'соответствует', 'неоднозначно'],
            description:
              'противоречит — ТЗ затрагивает тему и задаёт несовместимое со стандартом компании; соответствует — тема затронута и не противоречит; неоднозначно — тема затронута, но сформулирована двусмысленно/неполно. Темы, не затронутые в этой части ТЗ, НЕ возвращай.',
          },
          fragment: {
            type: 'string',
            description:
              'ДОСЛОВНАЯ цитата из ТЗ, где тема затронута. Для «противоречит» и «неоднозначно» — обязательна; для «соответствует» — желательна (короткая).',
          },
          section_path: {
            type: 'string',
            description: 'Путь заголовков ТЗ для цитаты (если есть). Иначе пустая строка.',
          },
          criticality: { type: 'string', enum: ['high', 'medium', 'low'] },
          suggested_redaction: {
            type: 'string',
            description: 'Предлагаемая формулировка для ТЗ/КП (как правило — стандартный текст условия). Может быть пустой.',
          },
          review_comment: {
            type: 'string',
            description: 'Краткий комментарий инженеру (на русском). Может быть пустым.',
          },
          basis: { type: 'string', description: 'Почему не отражено / в чём противоречие.' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
  },
  required: ['findings'],
});

const CHAR_BUDGET = Number(process.env.STAGE_LLM_CHAR_BUDGET) || 400000;
const SCAFFOLD_OVERHEAD = 600;

// Загружает существенные условия тендера (рендер стандартных + per-tender
// override), как делает rule-based runStage3. Возвращает [{ name, text,
// comment, criticality }].
async function loadConditions(tenderId) {
  const tender = await db.queryOne('SELECT * FROM tenders WHERE id = ?', tenderId);
  if (!tender) return [];
  // Колонка тендера — `type` (general_contract | shell | …); rule-based Стадия 3
  // читала несуществующий `contract_type` и всегда сваливалась в 'shell'.
  const kind = tenderTypeToContractKind(tender.type);
  const paramsRow = await db.queryOne('SELECT * FROM tender_setup_params WHERE tender_id = ?', tenderId);
  const params = { ...defaultsFor(kind), ...(paramsRow || {}) };
  const rendered = renderConditions(kind, params); // [{ idx, name, text, ... }]

  const overrides = await db.queryAll(
    `SELECT condition_idx, text_override, comment, criticality
     FROM company_conditions WHERE tender_id = ?`,
    tenderId,
  );
  const ovByIdx = new Map();
  for (const o of overrides) ovByIdx.set(o.condition_idx, o);

  const out = [];
  for (const cond of rendered) {
    const ov = ovByIdx.get(cond.idx);
    const text = (ov?.text_override || cond.text || '').trim();
    const name = (cond.name || '').trim();
    if (!name && !text) continue;
    out.push({
      name,
      text,
      comment: ov?.comment || null,
      criticality: ov?.criticality || null,
    });
  }
  return out;
}

function formatTopics(topics) {
  const conds = topics.filter((t) => t.kind === 'condition');
  const themes = topics.filter((t) => t.kind === 'topic');
  const lines = [];
  conds.forEach((c, i) => {
    lines.push(`### ${i + 1}. ${c.name}`);
    if (c.standard_text) lines.push(`Стандарт компании: ${c.standard_text}`);
    if (c.desc) lines.push(`Примечание компании: ${c.desc}`);
    lines.push('');
  });
  if (themes.length) {
    lines.push('### Темы покрытия (у компании нет стандартного текста — важно, СКАЗАНО ли об этом в ТЗ вообще):');
    themes.forEach((t) => {
      lines.push(`- ${t.name} — ${t.desc}`);
    });
    lines.push('');
  }
  return lines.join('\n').trim();
}

function buildUserMessage({ tzText, condsText, partIdx, partTotal }) {
  const partNote =
    partTotal > 1
      ? `## ТЗ — часть ${partIdx}/${partTotal} (markdown)\n\nЭто ФРАГМЕНТ ТЗ. Проверяй условия и темы против приведённого ниже ` +
        'текста; остальные части ТЗ проверяются отдельно. Тему, которая в этой части ' +
        'не затронута, просто не возвращай (в другой части она может быть затронута).'
      : '## ТЗ (markdown, целиком)';
  return [
    partNote,
    '',
    tzText && tzText.trim() ? tzText : '(пусто)',
    '',
    '---',
    '## Существенные условия компании и темы покрытия (справочник)',
    '',
    condsText,
    '',
    '---',
    'Пройди справочник и по КАЖДОЙ теме, ЗАТРОНУТОЙ в приведённом тексте ТЗ,',
    'верни статус: противоречит (с дословной цитатой), неоднозначно (с цитатой)',
    'или соответствует. Темы, не затронутые в этом тексте, не возвращай — их',
    'отсутствие по всему документу посчитает система. Верни JSON (поле findings).',
  ].join('\n');
}

// Нормализатор находки Стадии 3 → стандартная находка для buildIssue.
// Побочный эффект (сознательный): КАЖДЫЙ ответ модели, включая «соответствует»,
// записывается в аккумулятор покрытия coverage — по нему после прогона считается
// агрегированный статус каждой темы (в т.ч. «отсутствует»).
// Находками становятся:
//   противоречит  → Issue «условие_противоречит» (цитата обязательна);
//   неоднозначно  → Issue «условие_неоднозначно» (цитата обязательна);
//   соответствует → только матрица покрытия, Issue нет.
function makeMapFinding(byName, coverage) {
  return function mapFinding(f, segmentIndex) {
    const status = normalizePartStatus(f.status);
    const fragment = (f.fragment || '').trim();
    const name = (f.condition_name || '').trim();
    if (!status || !name) return null;
    coverage.push({
      name,
      status,
      fragment,
      section_path: f.section_path || '',
      segment: segmentIndex ?? null,
    });
    if (status === PART_STATUS.MATCHES) return null;
    if (!fragment) return null; // противоречие/неоднозначность без цитаты не локализуема
    const topic = byName.get(name.toLowerCase()) || null;
    const standardText = topic && topic.standard_text;

    if (status === PART_STATUS.AMBIGUOUS) {
      return {
        fragment,
        section_path: f.section_path || '',
        problem_type: 'условие_неоднозначно',
        risk_category: 'существенные_условия',
        criticality: f.criticality || (topic && topic.criticality) || 'medium',
        suggested_action: 'clarify',
        suggested_redaction: f.suggested_redaction || standardText || null,
        review_comment:
          f.review_comment ||
          `Тема «${name}» затронута в ТЗ, но сформулирована неоднозначно — запросить уточнение у Заказчика.`,
        basis: f.basis || `Формулировка ТЗ по теме «${name}» допускает разночтения.`,
        confidence: typeof f.confidence === 'number' ? f.confidence : 0.6,
      };
    }

    return {
      fragment,
      section_path: f.section_path || '',
      problem_type: 'условие_противоречит',
      risk_category: 'существенные_условия',
      criticality: (topic && topic.criticality) || f.criticality || 'high',
      suggested_action: 'replace',
      suggested_redaction: f.suggested_redaction || standardText || null,
      review_comment:
        f.review_comment ||
        `ТЗ противоречит существенному условию компании «${name}». Вынести на рассмотрение / привести в соответствие.`,
      basis: f.basis || `ТЗ противоречит стандартному условию компании «${name}».`,
      confidence: typeof f.confidence === 'number' ? f.confidence : 0.7,
    };
  };
}

async function runStage3Llm(context) {
  const { blocks, tenderId } = context;
  if (!Array.isArray(blocks) || !blocks.length) {
    const err = new Error('ТЗ.md пуст или не парсится. Загрузите корректный .md в слот ТЗ.');
    err.status = 400;
    throw err;
  }

  const conds = await loadConditions(tenderId);
  // Справочник стадии = условия компании + темы покрытия (COVERAGE_TOPICS).
  // Даже при пустом реестре условий стадия работает: темы покрытия — договорные
  // вопросы, отсутствие которых опасно для ГП независимо от настройки условий.
  const topics = buildTopicList(
    conds.map((c, i) => ({ idx: i + 1, name: c.name, text: c.text, comment: c.comment, criticality: c.criticality })),
  );
  const promptVariant = resolveVariant();
  const systemMsg = buildSystemPrompt(promptVariant);
  // eslint-disable-next-line no-console
  console.log(
    `[stage3_llm] model=${getModel()} promptVariant=${promptVariant} blocks=${blocks.length} ` +
      `условий: ${conds.length}, тем покрытия: ${topics.length - conds.length}`,
  );

  const condsText = formatTopics(topics);
  const byName = new Map(topics.map((t) => [t.name.trim().toLowerCase(), t]));
  const tzBudget = CHAR_BUDGET - condsText.length - SCAFFOLD_OVERHEAD - systemMsg.length;
  if (tzBudget <= 0) {
    const err = new Error('Справочник условий превышает бюджет контекста.');
    err.status = 400;
    throw err;
  }

  const coverageRecords = []; // аккумулятор ответов модели по всем частям
  const issues = await runLlmStage(context, {
    sourceDocumentId: context.sourceDocumentId,
    systemMsg,
    schema: RESPONSE_SCHEMA,
    schemaName: 'stage3_findings',
    tzBudget,
    concurrency: 1,
    riskCategory: 'существенные_условия',
    issueDefaults: { suggestedAction: 'replace', confidence: 0.7 },
    logTag: 'stage3_llm',
    keepUnlocated: false,
    mapFinding: makeMapFinding(byName, coverageRecords),
    buildUserMessage: (segment, partIdx, partTotal) =>
      buildUserMessage({ tzText: renderSegment(segment), condsText, partIdx, partTotal }),
  });

  // planOnly (карта затронутого): LLM не вызывался, аккумулятор пуст — считать
  // «всё отсутствует» и трогать матрицу нельзя.
  if (context.planOnly) return issues;

  // Агрегация по всем частям: «отсутствует» — только если тема не затронута
  // НИ В ОДНОЙ части. Находку гасит ТОЛЬКО явный ЗАКРЫВАЮЩИЙ статус инженера
  // (matches / other_document / not_applicable / resolved_in_contract /
  // risk_accepted): примечание без статуса или check_contract («надо
  // проверить») тему не закрывают — риск остаётся в реестре замечаний.
  const coverage = aggregateCoverage(topics, coverageRecords);
  const overrides = await coverageService.getOverrides(tenderId).catch(() => new Map());
  const segmentsTotal = (issues.segmentation && issues.segmentation.segments) || 0;

  const { emit: missingTopics, suppressed } = selectMissingTopics(topics, coverage, overrides);
  for (const topic of missingTopics) {
    issues.push(
      buildIssue({
        sourceDocumentId: context.sourceDocumentId,
        finding: buildMissingFinding(topic, { segmentsTotal }),
        located: null, // безъякорная находка: цитаты в ТЗ нет по определению
        riskCategory: 'существенные_условия',
        defaults: { suggestedAction: 'clarify', confidence: 0.6 },
      }),
    );
  }
  // eslint-disable-next-line no-console
  console.log(
    `[stage3_llm] покрытие: тем ${topics.length}, записей модели ${coverageRecords.length}, ` +
      `отсутствует ${missingTopics.length} (закрыто статусом инженера ${suppressed.length})`,
  );

  // Матрица покрытия — снимок ЭТОГО прогона (analysis_run_id). Best-effort:
  // сбой записи не роняет стадию (находки уже собраны).
  if (context.analysisRunId) {
    await coverageService
      .saveCoverage(tenderId, context.analysisRunId, [...coverage.values()])
      .catch((e) => {
        // eslint-disable-next-line no-console
        console.warn(`[stage3_llm] матрица покрытия не записана: ${e.message}`);
      });
  }
  return issues;
}

module.exports = { runStage3Llm, buildIssue, locateInBlocks };
