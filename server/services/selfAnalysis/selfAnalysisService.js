'use strict';

// Слой self-analysis — пятый шаг новой архитектуры анализа ТЗ
// (signals → draft_issues → critic → clustering → SELF-ANALYSIS).
//
// НОВАЯ роль Стадии 5 «Самоанализ ТЗ»: не второй хаотичный поток issues по тексту
// «с нуля», а QUALITY-CONTROL / COMPLETENESS-CHECK над уже собранным ИТОГОМ.
// Вход: исходный ТЗ + issue_clusters + issue_reviews + signals. Выход —
// self_analysis_results: замечания О РАЗБОРЕ четырёх типов:
//   • missed_coverage       — что могли пропустить (аспект ТЗ без кластера);
//   • weak_cluster          — где кластеры слабые (тонкое основание / нет рекомендации);
//   • cluster_contradiction — где противоречие между кластерами одного места ТЗ;
//   • needs_enrichment      — где усилить basis / review_comment / suggested_redaction.
//
// НЕ дублирует Стадию 4 (та ищет типовые риски в ТЕКСТЕ) — здесь оценка качества
// сборки. ПАРАЛЛЕЛЬНЫЙ слой: не трогает issues/review/export. Эвристики —
// ЧИСТЫЕ функции (тестируются без БД, как clustering/critic); LLM-обогащение —
// best-effort поверх них.

const db = require('../../db/connection');
const { newId, nowIso } = require('../../utils/ids');
const clustering = require('../clustering/clusteringService');
const critic = require('../critic/criticService');
const unified = require('../unifiedAnalysis/unifiedIssueBuilder');
const { listSignals } = require('../signals/signalWriter');
const analysisRuns = require('../analysisRuns/analysisRunsService');
const { getTzText } = require('../tzActiveTextService');
const { runSelfAnalysisLlm, FINDING_TYPES, QC_STATUS } = require('../stageAnalysis/stage5_llm');
const { makeStageSegmentStore } = require('../stageAnalysis/segments/segmentStore');
const { FAMILY } = require('../analysis/actions');
const { STATUS } = require('../analysis/resultStatus');

const CRIT_RANK = { critical: 4, high: 3, medium: 2, low: 1, none: 0 };
// Основание короче этого (без маркеров/пробелов) считаем слабым/общим.
const WEAK_BASIS_LEN = 40;
const LOW_CONFIDENCE = 0.5;

function normalize(s) {
  return (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Длина «содержательной» части основания (без буллетов/пробелов).
function basisLength(cluster) {
  return (cluster.merged_basis || '').replace(/[•\s]/g, '').length;
}

function hasRecommendation(cluster) {
  return Boolean((cluster.merged_recommendation || '').trim());
}

// Макс. уверенность по элементам кластера (для оценки «тонкого» одиночного кластера).
function maxItemConfidence(cluster) {
  const items = Array.isArray(cluster.items) ? cluster.items : [];
  if (!items.length) return 0;
  return items.reduce((m, it) => Math.max(m, Number(it.confidence) || 0), 0);
}

// Место ТЗ кластера — для поиска противоречащих кластеров на одном месте.
function placeOf(cluster) {
  const clause = normalize(cluster.tz_clause);
  if (clause) return `clause:${clause}`;
  if (cluster.paragraph_index != null) return `para:${cluster.paragraph_index}`;
  return `id:${cluster.id}`;
}

// Семейство действия кластера (хвост semantic_bucket = `${dimension}|${actionFamily}`).
// Единый реестр — remove | modify | note (analysis/actions). Легаси-хвост 'edit'
// нормализуем в 'modify' (старые кластеры в БД до унификации семейств).
function actionFamilyOf(cluster) {
  const tail = (cluster.semantic_bucket || '').split('|')[1] || FAMILY.NOTE;
  return tail === 'edit' ? FAMILY.MODIFY : tail;
}

function isHot(cluster) {
  const c = cluster.overall_criticality;
  return c === 'critical' || c === 'high';
}

function finding(type, clusterId, comment, improvement, opts = {}) {
  return {
    finding_type: type,
    cluster_id: clusterId || null,
    comment,
    suggested_improvement: improvement || '',
    confidence: opts.confidence != null ? opts.confidence : 0.6,
    source: opts.source || 'heuristic',
    related_cluster_id: opts.related_cluster_id || null,
  };
}

// --- Эвристические детекторы (чистые) ---------------------------------------

// (2) Слабые кластеры — НЕ высококритичные (для critical/high есть needs_enrichment):
// тонкое основание ИЛИ нет рекомендации ИЛИ одиночное замечание с низкой уверенностью.
function detectWeakClusters(clusters) {
  const out = [];
  for (const c of clusters) {
    if (isHot(c)) continue; // важные разбираются в needs_enrichment
    const reasons = [];
    if (basisLength(c) < WEAK_BASIS_LEN) reasons.push('основание кластера короткое/общее — проблема почти не обоснована');
    if (!hasRecommendation(c)) reasons.push('нет объединённой рекомендации — инженеру нечего предложить');
    if ((c.item_count || 0) <= 1 && maxItemConfidence(c) < LOW_CONFIDENCE) {
      reasons.push('единственное замечание с низкой уверенностью — кластер может быть шумом');
    }
    if (!reasons.length) continue;
    out.push(
      finding(
        'weak_cluster',
        c.id,
        `Слабый кластер «${c.cluster_title || c.tz_clause || c.id}»: ${reasons.join('; ')}.`,
        'Добавить доказательную базу (цитату ТЗ, расчёт) или подтвердить ещё одним сигналом; иначе понизить значимость.',
      ),
    );
  }
  return out;
}

// (3) Противоречия между кластерами одного места ТЗ: один предлагает убрать пункт
// (remove), другой — оставить и поправить/прокомментировать (modify/note, т.е.
// любое НЕ-remove семейство).
function detectContradictions(clusters) {
  const byPlace = new Map();
  for (const c of clusters) {
    const k = placeOf(c);
    if (!byPlace.has(k)) byPlace.set(k, []);
    byPlace.get(k).push(c);
  }
  const out = [];
  for (const group of byPlace.values()) {
    if (group.length < 2) continue;
    const remover = group.find((c) => actionFamilyOf(c) === FAMILY.REMOVE);
    const keeper = group.find((c) => actionFamilyOf(c) !== FAMILY.REMOVE);
    if (!remover || !keeper || remover.id === keeper.id) continue;
    out.push(
      finding(
        'cluster_contradiction',
        remover.id,
        `Противоречие на одном месте ТЗ (${remover.tz_clause || placeOf(remover)}): кластер «${remover.cluster_title}» ` +
          `предлагает убрать пункт из объёма, а «${keeper.cluster_title}» — оставить и поправить/прокомментировать. ` +
          'Инженер получит взаимоисключающие рекомендации.',
        'Свести к одному решению по этому месту ТЗ или явно развести области (что убрать, что оставить).',
        { related_cluster_id: keeper.id, confidence: 0.7 },
      ),
    );
  }
  return out;
}

// (4) Где усилить — важные (critical/high) кластеры с тонким основанием / без
// готовой рекомендации (suggested_redaction).
function detectEnrichmentNeeds(clusters) {
  const out = [];
  for (const c of clusters) {
    if (!isHot(c)) continue;
    const gaps = [];
    if (!hasRecommendation(c)) gaps.push('нет готовой формулировки правки (suggested_redaction) — для high/critical обязательна');
    if (basisLength(c) < WEAK_BASIS_LEN) gaps.push('обоснование (basis) не дотягивает до заявленной критичности');
    if (!gaps.length) continue;
    out.push(
      finding(
        'needs_enrichment',
        c.id,
        `Важный кластер «${c.cluster_title}» (${c.overall_criticality}) недо-оформлен: ${gaps.join('; ')}.`,
        'Дописать конкретный suggested_redaction (ограничение объёма ссылкой на раздел / точная формулировка) и усилить basis.',
        { confidence: 0.65 },
      ),
    );
  }
  return out;
}

// (1) Что могли пропустить — категории сигналов, которые не отражены ни в одном
// кластере (аспект ушёл в сборке). signalStats считается отдельно из signals+clusters.
function detectMissedCoverage(signalStats) {
  const out = [];
  for (const cat of signalStats.missedCategories) {
    out.push(
      finding(
        'missed_coverage',
        null,
        `Сигналы категории «${cat}» есть (${signalStats.signalsByCategory[cat]} шт.), но ни один кластер их не отражает — ` +
          'аспект мог потеряться при сборке итога.',
        `Проверить место(а) ТЗ по категории «${cat}» и при необходимости добавить кластер/замечание.`,
        { confidence: 0.55 },
      ),
    );
  }
  return out;
}

// Статистика сигналов vs кластеров (чистая): какие категории сигналов потеряны.
function computeSignalStats(signals, clusters) {
  const signalsByCategory = {};
  for (const s of signals || []) {
    const cat = s.signal_type || '—';
    signalsByCategory[cat] = (signalsByCategory[cat] || 0) + 1;
  }
  const clusterCats = new Set();
  for (const c of clusters || []) {
    for (const it of c.items || []) {
      if (it.category) String(it.category).split('+').forEach((p) => clusterCats.add(p.trim()));
    }
  }
  const missedCategories = Object.keys(signalsByCategory).filter((cat) => cat !== '—' && !clusterCats.has(cat));
  return {
    signals_total: (signals || []).length,
    signalsByCategory,
    cluster_categories: [...clusterCats],
    missedCategories,
  };
}

// Все эвристики разом (чистая) — порядок задаёт порядок вывода в UI.
function runHeuristics(clusters, signalStats) {
  return [
    ...detectMissedCoverage(signalStats),
    ...detectContradictions(clusters),
    ...detectWeakClusters(clusters),
    ...detectEnrichmentNeeds(clusters),
  ];
}

// Нормализация одной LLM-находки к записи self_analysis_results.
function normalizeLlmFinding(raw, clusterIds) {
  const ft = FINDING_TYPES.includes(raw && raw.finding_type) ? raw.finding_type : 'missed_coverage';
  const cidRaw = (raw && raw.cluster_id) || '';
  const cid = cidRaw && clusterIds.has(cidRaw) ? cidRaw : null;
  let conf = Number(raw && raw.confidence);
  if (!Number.isFinite(conf)) conf = 0.5;
  conf = Math.max(0, Math.min(1, conf));
  return finding(ft, cid, String((raw && raw.comment) || '').trim(), String((raw && raw.suggested_improvement) || '').trim(), {
    confidence: conf,
    source: 'llm',
  });
}

// Свести эвристики + LLM, убрать дубли (тип + cluster_id + начало comment).
function assembleFindings(heuristic, llm) {
  const out = [];
  const seen = new Set();
  const keyOf = (f) => `${f.finding_type}|${f.cluster_id || ''}|${normalize(f.comment).slice(0, 60)}`;
  for (const f of [...heuristic, ...llm]) {
    if (!f.comment) continue;
    const k = keyOf(f);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  return out;
}

// --- Исход слоя self-analysis (чистая функция) --------------------------------

// Сводит исход LLM-шага QC в исход СЛОЯ. Раньше здесь была дыра: LLM-шаг бросал
// «не досчитана ни одна часть», вызывающий глотал исключение и отдавал успешный
// результат на одних эвристиках — портал видел зелёный после полного отказа QC.
// Теперь исход явный:
//   0 из N частей   → failed (usable=false: слой не собран, вызывающий обязан упасть);
//   1..N-1 из N     → completed_with_warnings (partial);
//   N из N          → completed;
//   кластеров нет   → completed + llm_status=not_applicable (проверять нечего, НЕ сбой);
//   LLM не настроен → completed_with_warnings + llm_status=skipped (QC не выполнялся,
//                     эвристики в силе, но зелёным это не считаем).
function resolveSelfAnalysisOutcome(llm) {
  const qc = llm && llm.status ? llm.status : QC_STATUS.FAILED;
  const seg = (llm && llm.segmentation) || null;
  const failedParts = (seg && seg.failed_parts) || null;
  const reason = (llm && llm.reason) || null;
  const base = { llm_status: qc, llm_reason: reason, failed_parts: failedParts };

  if (qc === QC_STATUS.COMPLETED_WITH_WARNINGS || qc === QC_STATUS.SKIPPED) {
    return { ...base, status: STATUS.COMPLETED_WITH_WARNINGS, partial: true, usable: true };
  }
  if (qc === QC_STATUS.COMPLETED || qc === QC_STATUS.NOT_APPLICABLE) {
    return { ...base, status: STATUS.COMPLETED, partial: false, usable: true };
  }
  // failed и любой неизвестный исход — fail-closed: лучше признать отказ, чем
  // случайно отрапортовать успех (тот самый ложный успех, который мы убираем).
  return { ...base, llm_status: QC_STATUS.FAILED, status: STATUS.FAILED, partial: false, usable: false };
}

// --- DB-обвязка -------------------------------------------------------------

// Если кластеров ещё нет — best-effort собрать конвейер из накопленных сигналов
// (draft_issues → critic → clustering), чтобы QC было что проверять. Сбой не
// фатален: вернём false и продолжим с тем, что есть.
async function ensureClusters(tenderId, runId) {
  const row = await db.queryOne(
    'SELECT COUNT(*) AS c FROM issue_clusters WHERE tender_id = ? AND analysis_run_id = ?',
    tenderId, runId,
  );
  if (Number(row && row.c) > 0) return false;
  try {
    await unified.buildDraftIssues(tenderId, runId);
    await critic.buildIssueReviews(tenderId, runId);
    await clustering.buildClusters(tenderId, runId);
    return true;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[selfAnalysis] не удалось авто-собрать кластеры: ${e.message}`);
    return false;
  }
}

// Главная функция: собрать self_analysis_results и сохранить (idempotent в
// пределах прогона). Возвращает summary + items.
//
// runId — прогон-КАНДИДАТ (его даёт оркестратор конвейера). Без runId QC НЕ
// трогает действующий снимок: создаётся новый кандидат, ensureClusters достраивает
// в него свои слои, указатель остаётся на прежнем прогоне. Прежнее поведение
// (ensurePipelineRun → DELETE+INSERT self_analysis_results в АКТИВНОМ снимке)
// было мутацией уже выданного результата.
async function buildSelfAnalysis(tenderId, runId) {
  const rid = runId || await analysisRuns.beginCandidateRun(tenderId, { reason: 'self_analysis.build' });
  await ensureClusters(tenderId, rid);

  const clusters = await clustering.listClusters(tenderId, 'full', rid);
  const signals = await listSignals(tenderId, {});
  const signalStats = computeSignalStats(signals, clusters);

  // ТЗ для QC берём БЛОКАМИ: агент проверяет полноту разбора по частям
  // документа (иерархическая сегментация), а не по усечённому началу файла.
  let tzText = '';
  let tzBlocks = [];
  let tzRevisionId = null;
  try {
    const tz = await getTzText(tenderId);
    tzText = (tz && (tz.activeText || tz.rawText)) || '';
    tzBlocks = (tz && tz.blocks) || [];
    tzRevisionId = (tz && tz.revisionId) || null;
  } catch (e) {
    // ТЗ.md может отсутствовать — QC по кластерам всё равно отработает на эвристиках.
    // eslint-disable-next-line no-console
    console.warn(`[selfAnalysis] ТЗ-текст недоступен: ${e.message}`);
  }

  const heuristic = runHeuristics(clusters, signalStats);

  // Исход LLM-шага QC — явный (см. resolveSelfAnalysisOutcome). runSelfAnalysisLlm
  // не бросает: «не досчитана ни одна часть» приходит как status=failed. Неожидан-
  // ное исключение (баг/инфраструктура) тоже трактуем как отказ слоя, а НЕ как
  // «пропустим обогащение и отрапортуем успех на эвристиках».
  const qcSegmentStore = makeStageSegmentStore({
    tenderId,
    stage: 5,
    revisionId: tzRevisionId,
    configVersion: analysisRuns.currentConfigVersion(),
    runId: rid,
    logTag: 'selfAnalysis',
  });

  let qc;
  try {
    qc = await runSelfAnalysisLlm({
      tzText,
      tzBlocks,
      clusters,
      signalStats,
      // Части QC: результат — в кэш ревизии (analysis_segments), история
      // выполнения — в прогон rid (analysis_run_segments). Видно, какая часть не
      // досчиталась, и её можно перезапустить точечно; летопись прошлого прогона
      // при этом не затирается.
      segmentStore: qcSegmentStore,
    });
  } catch (e) {
    qc = { status: QC_STATUS.FAILED, findings: [], segmentation: null, reason: e.message };
  }
  // Живых (pending/running) частей у отработавшего QC остаться не должно:
  // «не дошли» → skipped, «считалась в момент обрыва» → interrupted.
  await qcSegmentStore.finalize({ reason: 'QC-шаг самоанализа завершён' });
  const outcome = resolveSelfAnalysisOutcome(qc);
  if (outcome.llm_status !== QC_STATUS.COMPLETED) {
    // eslint-disable-next-line no-console
    console.warn(`[selfAnalysis] LLM-QC: ${outcome.llm_status} — ${outcome.llm_reason || 'без причины'}`);
  }
  const clusterIds = new Set(clusters.map((c) => c.id));
  const llm = ((qc && qc.findings) || []).map((r) => normalizeLlmFinding(r, clusterIds));

  const findings = assembleFindings(heuristic, llm).map((f) => ({ id: newId(), tender_id: tenderId, ...f }));

  await db.transaction(async (tx) => {
    // Страж неизменяемости снимка (см. analysisRuns.assertRunWritable).
    await analysisRuns.assertRunWritable(tenderId, rid, { kind: 'pipeline' }, tx);
    await tx.queryRun('DELETE FROM self_analysis_results WHERE tender_id = ? AND analysis_run_id = ?', tenderId, rid);
    const createdAt = nowIso();
    for (const f of findings) {
      await tx.queryRun(
        `INSERT INTO self_analysis_results (
           id, tender_id, analysis_run_id, cluster_id, finding_type, comment, suggested_improvement,
           confidence, source, related_cluster_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        f.id, f.tender_id, rid, f.cluster_id, f.finding_type, f.comment, f.suggested_improvement,
        f.confidence, f.source, f.related_cluster_id, createdAt,
      );
    }
  });

  const byType = findings.reduce((acc, f) => {
    acc[f.finding_type] = (acc[f.finding_type] || 0) + 1;
    return acc;
  }, {});

  const summary = {
    run_id: rid,
    clusters: clusters.length,
    signals: signalStats.signals_total,
    findings: findings.length,
    heuristic: heuristic.length,
    llm: llm.length,
    by_type: byType,
    missed_categories: signalStats.missedCategories,
    // Единый контракт результата слоя (resultStatus) + исход LLM-шага QC:
    // completed | completed_with_warnings | failed | skipped | not_applicable.
    status: outcome.status,
    llm_status: outcome.llm_status,
    llm_reason: outcome.llm_reason,
    segmentation: (qc && qc.segmentation) || null,
    // Частичный QC: часть(и) ТЗ не досчитаны либо QC не выполнялся. Читатели
    // (движок стадии, оркестратор конвейера) обязаны пометить исход warning,
    // а не success.
    failed_parts: outcome.failed_parts,
    partial: outcome.partial,
  };

  // Слой не собран (QC был запрошен и не досчитал НИ ОДНУ часть) — это отказ.
  // Бросаем ПОСЛЕ записи: эвристические находки прогона не теряются (прогон
  // всё равно не будет активирован), но исход честный — вызывающий (движок
  // стадии 5 / шаг конвейера / контроллер) не выдаст его за успех.
  if (!outcome.usable) {
    const err = new Error(`Самоанализ (QC) не выполнен: ${outcome.llm_reason || 'LLM-шаг не дал результата'}`);
    err.status = 502;
    err.code = 'SELF_ANALYSIS_FAILED';
    err.selfAnalysis = summary;
    throw err;
  }

  return { summary, items: findings };
}

// Читает находки + заголовок/критичность связанного кластера. Опциональный
// фильтр по finding_type.
// runId (опц.) — читать КОНКРЕТНЫЙ прогон (кандидата на debug-странице).
async function listSelfAnalysis(tenderId, { findingType, runId } = {}) {
  const rid = runId || await analysisRuns.getActivePipelineRunId(tenderId);
  if (!rid) return [];
  const params = [tenderId, rid];
  let where = 's.tender_id = ? AND s.analysis_run_id = ?';
  if (findingType) {
    where += ' AND s.finding_type = ?';
    params.push(findingType);
  }
  return db.queryAll(
    `SELECT s.*, c.cluster_title, c.tz_clause AS cluster_tz_clause, c.overall_criticality
       FROM self_analysis_results s
       LEFT JOIN issue_clusters c ON c.id = s.cluster_id
      WHERE ${where}
      ORDER BY s.created_at ASC`,
    ...params,
  );
}

module.exports = {
  // чистое ядро (офлайн-тесты)
  basisLength,
  actionFamilyOf,
  computeSignalStats,
  detectWeakClusters,
  detectContradictions,
  detectEnrichmentNeeds,
  detectMissedCoverage,
  runHeuristics,
  normalizeLlmFinding,
  assembleFindings,
  resolveSelfAnalysisOutcome,
  QC_STATUS,
  // DB
  ensureClusters,
  buildSelfAnalysis,
  listSelfAnalysis,
};
