'use strict';

// CHALLENGER — независимый второй взгляд на ТЗ (механизм Б разделения Стадии 5).
//
// Прежняя Стадия 5 получала противоречивые инструкции: «не ищи замечания заново»
// и одновременно «проверь, что пропущено». Теперь роли разделены:
//   • QC (stage5_llm + selfAnalysisService) проверяет КАЧЕСТВО существующих
//     кластеров и пропусков НЕ ищет;
//   • CHALLENGER (этот модуль) получает исходный ТЗ и СПИСОК УЖЕ НАЙДЕННОГО
//     (дайджест кластеров) и ищет материальные риски, НЕ покрытые основными
//     стадиями. Его находки — ОБЫЧНЫЕ цитатные замечания (issues стадии 5):
//     публикуются штатным снимком с сигналами, проходят критика и кластеризацию
//     и получают решение инженера — а не заметку в debug-контуре.
//
// Дедупликация двухслойная: промт получает список покрытых мест (модель обязана
// их пропускать), а детерминированный фильтр isCoveredByExisting отбрасывает
// находки, чья цитата пересекается с цитатой существующего кластера.

const { getModel } = require('./llm/openaiClient');
const { renderSegment, runLlmStage, buildIssue, locateInBlocks } = require('./shared/llmStage');
const { attachMateriality, withMaterialityPrompt } = require('./shared/materialityFields');
const { ALL_ACTIONS } = require('../analysis/actions');

// Домен challenger-находок: типы Стадии 5 (см. review/stageDomains).
const CHALLENGER_PROBLEM_TYPES = Object.freeze([
  'пропущенный_риск',
  'скрытые_работы',
  'двусмысленная_формулировка',
  'влияние_на_срок',
]);

const RESPONSE_SCHEMA = attachMateriality({
  type: 'object',
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['fragment', 'section_path', 'problem_type', 'criticality', 'suggested_action', 'basis', 'confidence'],
        properties: {
          fragment: {
            type: 'string',
            description: 'ДОСЛОВНАЯ цитата из ТЗ с пропущенным риском (обязательна).',
          },
          section_path: { type: 'string', description: 'Путь заголовков ТЗ. Пустая строка, если вне заголовка.' },
          problem_type: { type: 'string', enum: [...CHALLENGER_PROBLEM_TYPES] },
          criticality: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          suggested_action: { type: 'string', enum: ALL_ACTIONS },
          suggested_redaction: { type: 'string', description: 'Готовая формулировка правки/допущения. Может быть пустой.' },
          review_comment: { type: 'string', description: 'Практический совет инженеру (на русском).' },
          basis: {
            type: 'string',
            description:
              'Почему это РЕАЛЬНЫЙ пропуск: какое денежное/объёмное/срочное последствие для ГП и почему тема не покрыта списком найденного.',
          },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
  },
  required: ['findings'],
});

const SYSTEM_PROMPT = withMaterialityPrompt([
  'Ты — НЕЗАВИСИМЫЙ проверяющий (challenger) тендерного отдела Генподрядчика (ГП).',
  'Основные агенты уже разобрали текст ТЗ; тебе дают их ИТОГ — список уже',
  'найденных замечаний (кластеры: место + тема + рекомендация) — и исходный ТЗ.',
  '',
  'ЗАДАЧА: найти то, что ОСНОВНЫЕ АГЕНТЫ ПРОПУСТИЛИ. Ты ИЩЕШЬ ЗАНОВО — читай',
  'текст свежим взглядом, как будто разбора не было, но ВЫНОСИ только находки,',
  'НЕ покрытые списком найденного. Уже покрытое место/тему НЕ повторяй — даже',
  'если формулируешь лучше: повтор не помогает инженеру.',
  '',
  'Что считается пропуском (problem_type):',
  '• пропущенный_риск — материальный риск ГП (объём, цена, срок, оплата,',
  '  ответственность), который не отражён ни в одном найденном замечании;',
  '• скрытые_работы — обязанность/работа, «спрятанная» в формулировке и не',
  '  посчитанная (следует из текста, но не названа работой);',
  '• двусмысленная_формулировка — место, которое можно прочитать двумя способами',
  '  с разной ценой для ГП;',
  '• влияние_на_срок — скрытое влияние формулировки на срок/график.',
  '',
  'ЖЁСТКИЕ ПРАВИЛА:',
  '• fragment — ДОСЛОВНАЯ цитата из приведённого текста ТЗ, иначе находка',
  '  потеряется. Находок «про документ в целом» без цитаты не давать.',
  '• В basis обязательно КОНКРЕТНОЕ экономическое/срочное последствие для ГП;',
  '  без последствия находку не давать.',
  '• Не выноси редактуру, стилистику и стандартные нормативные требования.',
  '• Каждую находку сверь со списком найденного: если место или тема уже там —',
  '  пропускай. Лучше 3 настоящих пропуска, чем 20 повторов.',
  '',
  'Рассуждай про себя — в ответ верни только итоговый JSON (поле findings).',
].join('\n'));

const CHAR_BUDGET = Number(process.env.STAGE_LLM_CHAR_BUDGET) || 400000;
const SCAFFOLD_OVERHEAD = 600;

function normalize(s) {
  return (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Компактный дайджест уже найденного для промта и дедупа. Берём место (пункт),
// заголовок темы и цитату-представителя кластера.
function buildCoveredDigest(clusters) {
  const items = [];
  for (const c of clusters || []) {
    items.push({
      place: c.tz_clause || null,
      title: c.cluster_title || null,
      quote: (c.representative_fragment || '').slice(0, 200) || null,
    });
  }
  return items;
}

function renderCovered(covered) {
  if (!covered.length) return '(основные агенты не нашли ничего — любой материальный риск будет пропуском)';
  return covered
    .map((c, i) => `${i + 1}. ${c.place || '—'} · ${c.title || '—'}${c.quote ? ` · «${c.quote}»` : ''}`)
    .join('\n');
}

// Детерминированный фильтр повторов: цитата challenger-находки пересекается с
// цитатой уже найденного кластера (контейнмент нормализованных строк). Порог
// длины отсекает вырожденные совпадения на коротких обрывках.
function isCoveredByExisting(fragment, coveredQuotes, { minLen = 15 } = {}) {
  const f = normalize(fragment);
  if (f.length < minLen) return false;
  for (const q of coveredQuotes) {
    if (!q || q.length < minLen) continue;
    if (f.includes(q) || q.includes(f)) return true;
  }
  return false;
}

function buildUserMessage({ tzText, coveredText, partIdx, partTotal }) {
  const partNote =
    partTotal > 1
      ? `## ТЗ — часть ${partIdx}/${partTotal} (markdown)\n\nЭто ФРАГМЕНТ ТЗ. Ищи пропуски только в приведённом ниже тексте; остальные части проверяются отдельно.`
      : '## ТЗ (markdown)';
  return [
    '## Уже найдено основными агентами (НЕ повторять)',
    '',
    coveredText,
    '',
    '---',
    partNote,
    '',
    tzText && tzText.trim() ? tzText : '(пусто)',
    '',
    '---',
    'Найди в приведённом тексте материальные риски ГП, НЕ покрытые списком выше.',
    'Каждая находка — с дословной цитатой и конкретным последствием. Верни JSON',
    'по схеме (поле findings).',
  ].join('\n');
}

// Сканирование ТЗ по частям (тот же каркас, что у стадий 1–4: сегментация, кэш
// частей, локализация цитат). ctx: { tenderId, blocks, sourceDocumentId,
// analysisRunId, segmentStore?, planOnly?, progress?, jobControl? }.
// clusters — итог конвейера (уже собранные кластеры кандидата).
async function runChallengerScan(ctx, clusters) {
  const covered = buildCoveredDigest(clusters);
  const coveredText = renderCovered(covered);
  const coveredQuotes = covered.map((c) => normalize(c.quote)).filter(Boolean);

  const tzBudget = CHAR_BUDGET - coveredText.length - SCAFFOLD_OVERHEAD - SYSTEM_PROMPT.length;
  if (tzBudget <= 0) {
    const err = new Error('Дайджест найденных замечаний превышает бюджет контекста challenger-агента.');
    err.status = 400;
    throw err;
  }
  // eslint-disable-next-line no-console
  console.log(
    `[challenger] model=${getModel()} blocks=${(ctx.blocks || []).length} покрыто кластерами: ${covered.length}`,
  );

  let droppedCovered = 0;
  const issues = await runLlmStage(ctx, {
    sourceDocumentId: ctx.sourceDocumentId,
    systemMsg: SYSTEM_PROMPT,
    schema: RESPONSE_SCHEMA,
    schemaName: 'challenger_findings',
    tzBudget,
    concurrency: 1,
    riskCategory: 'объём_и_обязательства',
    issueDefaults: { suggestedAction: 'comment', confidence: 0.6 },
    logTag: 'challenger',
    keepUnlocated: false, // пропуск без цитаты — не находка challenger'а
    mapFinding: (f) => {
      const fragment = (f.fragment || '').trim();
      if (!fragment) return null;
      if (!CHALLENGER_PROBLEM_TYPES.includes(f.problem_type)) f.problem_type = 'пропущенный_риск';
      if (isCoveredByExisting(fragment, coveredQuotes)) {
        droppedCovered += 1;
        return null;
      }
      return f;
    },
    buildUserMessage: (segment, partIdx, partTotal) =>
      buildUserMessage({ tzText: renderSegment(segment), coveredText, partIdx, partTotal }),
  });
  // eslint-disable-next-line no-console
  console.log(`[challenger] находок ${issues.length}, отброшено как покрытые: ${droppedCovered}`);
  issues.droppedCovered = droppedCovered;
  return issues;
}

module.exports = {
  CHALLENGER_PROBLEM_TYPES,
  RESPONSE_SCHEMA,
  SYSTEM_PROMPT,
  buildCoveredDigest,
  renderCovered,
  isCoveredByExisting,
  buildUserMessage,
  runChallengerScan,
  buildIssue,
  locateInBlocks,
};
