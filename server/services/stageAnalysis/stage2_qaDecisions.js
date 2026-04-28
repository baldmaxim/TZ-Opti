'use strict';

/**
 * Стадия 2: Q&A → правки в ТЗ.
 *
 * Контракт: (context) → Issue[]
 * context = { tenderId, paragraphs, qaEntries, sourceDocumentId }
 *
 * Логика:
 *   1. Классификация принятого решения (СУ-10) по ключевым словам:
 *      EXCLUDED       → решение исключает работу из КП → remove_from_scope
 *      MISSING_INFO   → заказчик не предоставил данные → clarify
 *      DEFERRED       → отложенный ответ (см.вложение, не ранее DD.MM) → comment
 *      INCLUDED       → решение подтверждает учёт работы → comment (low)
 *      ACKNOWLEDGED   → «принято к сведению» без действия — пропускаем
 *      CUSTOM         → длинный индивидуальный текст — пропускаем (требует ручной флаг)
 *   2. Ручные флаги в qa_entries оверрайдят авто-классификацию:
 *      tz_contradicts=1 → действие replace, criticality high
 *      tz_reflected=1   → понижаем criticality (фиксация)
 *   3. Якорь правки берётся из tz_clause (через сшивку параграфов из qaTzLinkService).
 *      Если якоря нет — issue эмитится без paragraph_index (всё равно полезен для review).
 */

const { reconstituteParagraphs } = require('../qaTzLinkService');

function classify(text) {
  if (!text) return 'NONE';
  const t = String(text);
  if (/не\s*учтен|не\s*входит|не\s*предусмотр|вне\s*объ[её]ма/i.test(t)) return 'EXCLUDED';
  if (/отсутству|нет\s*информаци|не\s*предоставл|документация\s*отсутству/i.test(t)) return 'MISSING_INFO';
  if (/не\s*ранее|будет\s*получен|будет\s*разработ|в\s*разработк|см\.\s*вложен|после\s*утверждени/i.test(t)) return 'DEFERRED';
  if (/учтен[оаы]|учтена|включено|включен[оа]/i.test(t)) return 'INCLUDED';
  if (/принято\s*к\s*сведени/i.test(t)) return 'ACKNOWLEDGED';
  return 'CUSTOM';
}

function findParagraphByRef(paragraphs, ref) {
  if (!ref) return null;
  const mClause = ref.match(/п\.\s*(\d+(?:\.\d+){1,5})/);
  if (mClause) {
    const num = mClause[1];
    return paragraphs.find((p) => p.clause === num) || null;
  }
  const mAbz = ref.match(/абз\.\s*(\d+)/);
  if (mAbz) {
    const idx = Number(mAbz[1]) - 1;
    return paragraphs.find((p) => p.index === idx) || null;
  }
  return null;
}

function shouldEmit(cls, entry) {
  if (entry.tz_contradicts) return true;
  if (cls === 'EXCLUDED' || cls === 'MISSING_INFO' || cls === 'DEFERRED') return true;
  if (cls === 'INCLUDED' && entry.tz_clause) return true;
  if (entry.affects_calc || entry.affects_kp || entry.affects_contract || entry.affects_schedule) return true;
  return false;
}

function buildIssueFromEntry(entry, paragraph, sourceDocumentId, cls) {
  const q = (entry.question || '').slice(0, 100);
  const a = (entry.answer || '').slice(0, 140);
  const d = (entry.accepted_decision || '').slice(0, 200);
  const contradicts = !!entry.tz_contradicts;

  let action;
  let criticality;
  let problem_type;
  let risk_category;
  let basis;
  let suggested_redaction = null;
  let price_impact = 'нет';
  let schedule_impact = 'нет';

  if (contradicts) {
    action = 'replace';
    criticality = 'high';
    problem_type = 'qa_противоречит_тз';
    risk_category = 'договорной';
    basis = `ТЗ противоречит принятому решению СУ-10. Вопрос: «${q}». Ответ заказчика: «${a}». Решение: «${d}».`;
    suggested_redaction = `Изменить пункт ТЗ в соответствии с решением СУ-10: «${d}»`;
    price_impact = 'высокое';
  } else if (cls === 'EXCLUDED') {
    action = 'remove_from_scope';
    criticality = 'high';
    problem_type = 'qa_исключено_из_кп';
    risk_category = 'объём_работ';
    basis = `Решение СУ-10 исключает работу из расчёта: «${d}». Источник: Q&A раздел «${entry.section}», вопрос «${q}».`;
    suggested_redaction = `Убрать пункт из объёма работ или явно вынести из КП.`;
    price_impact = 'высокое';
  } else if (cls === 'MISSING_INFO') {
    action = 'clarify';
    criticality = 'medium';
    problem_type = 'qa_отсутствует_информация';
    risk_category = 'данные';
    basis = `Заказчик не предоставил информацию по запросу. Вопрос: «${q}». Ответ: «${a}». Решение: «${d}».`;
    price_impact = 'возможно';
  } else if (cls === 'DEFERRED') {
    action = 'comment';
    criticality = 'medium';
    problem_type = 'qa_отложенный_ответ';
    risk_category = 'данные';
    basis = `Открытый вопрос: ответ обещан позже. Вопрос: «${q}». Ответ: «${a || d}».`;
    schedule_impact = 'возможно';
  } else if (cls === 'INCLUDED') {
    action = 'comment';
    criticality = 'low';
    problem_type = 'qa_подтверждено';
    risk_category = 'фиксация';
    basis = `Подтверждено по Q&A. Решение СУ-10: «${d}». Вопрос: «${q}».`;
  } else {
    // CUSTOM с поднятыми контурными флагами
    action = 'comment';
    criticality = 'medium';
    problem_type = 'qa_влияет_на_контур';
    risk_category = 'фиксация';
    const flags = [];
    if (entry.affects_calc) flags.push('расчёт');
    if (entry.affects_kp) flags.push('КП');
    if (entry.affects_contract) flags.push('договор');
    if (entry.affects_schedule) flags.push('график');
    basis = `Решение СУ-10 влияет на ${flags.join('/') || 'контур'}: «${d}». Q&A: «${q}».`;
  }

  // Понижаем criticality, если инженер пометил, что в ТЗ уже отражено.
  if (entry.tz_reflected && !contradicts) {
    if (criticality === 'high') criticality = 'medium';
    else if (criticality === 'medium') criticality = 'low';
  }

  const flagBadges = [
    entry.affects_calc ? 'Р' : null,
    entry.affects_kp ? 'К' : null,
    entry.affects_contract ? 'Д' : null,
    entry.affects_schedule ? 'Г' : null,
  ].filter(Boolean).join('+');

  return {
    source_document_id: sourceDocumentId,
    source_clause: entry.tz_clause || null,
    source_fragment: paragraph ? paragraph.text.slice(0, 140) : (entry.section || null),
    paragraph_index: paragraph ? paragraph.index : null,
    char_start: paragraph ? 0 : null,
    char_end: paragraph ? Math.min(paragraph.text.length, 200) : null,
    problem_type,
    risk_category,
    criticality,
    price_impact,
    schedule_impact,
    basis,
    suggested_action: action,
    suggested_redaction,
    review_comment: `Источник: Q&A №${(entry.order_idx ?? 0) + 1}, раздел «${entry.section || '—'}»${entry.round_label ? ', ' + entry.round_label : ''}${flagBadges ? '. Контуры: ' + flagBadges : ''}.`,
    confidence: paragraph ? 0.75 : 0.5,
  };
}

function runStage2(context) {
  const { paragraphs, qaEntries, sourceDocumentId, rawText } = context;
  if (!qaEntries || !qaEntries.length) return [];

  // Сшивка параграфов из сырого текста — нужна, чтобы корректно резолвить шифры «п. X.Y.Z».
  const reconstituted = rawText ? reconstituteParagraphs(rawText) : [];
  const lookup = reconstituted.length ? reconstituted : (paragraphs || []);

  const issues = [];
  for (const entry of qaEntries) {
    const cls = classify(entry.accepted_decision);
    if (!shouldEmit(cls, entry)) continue;
    const para = findParagraphByRef(lookup, entry.tz_clause);
    issues.push(buildIssueFromEntry(entry, para, sourceDocumentId, cls));
  }
  return issues;
}

module.exports = { runStage2, classify, findParagraphByRef };
