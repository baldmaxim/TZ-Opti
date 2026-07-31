'use strict';

const path = require('path');
const fs = require('fs');
const db = require('../db/connection');
const { notFound, badRequest } = require('../utils/errors');
const { exportReviewedDocx } = require('../services/reviewDocx');
const exportSvc = require('../services/exportService');
const { renderReviewMd } = require('../services/mdReview/renderer');
const { dedupeExportDecisions } = require('../services/review/consolidation');
const clusterReview = require('../services/review/clusterReviewService');
const analysisRuns = require('../services/analysisRuns/analysisRunsService');
const { pickPrimaryDocument } = require('../services/documents/manifestModel');
const readiness = require('../services/review/reviewReadinessService');

// Legacy issue-путь — ТОЛЬКО ЯВНО: ?source=issues (старый тендер без кластеров)
// или пер-стадийная выгрузка ?stage=. Пустой массив кластерных решений legacy
// больше НЕ включает — вместо этого срабатывает гейт готовности рецензии.
const isExplicitLegacy = (query) => query.source === 'issues' || Boolean(query.stage);

async function getTzOriginal(tenderId) {
  // Для экспорта в .docx нужен именно .docx-файл (не .md и не .pdf).
  // Слот ТЗ может содержать оба формата параллельно — выбираем только .docx,
  // актуальный по манифесту пакета (superseded-редакция не экспортируется).
  const docs = await db.queryAll('SELECT * FROM documents WHERE tender_id = ?', tenderId);
  return pickPrimaryDocument(docs, 'tz', { match: /\.docx$/i });
}

// Legacy-fallback loader: решения по issues (review_decisions.issue_id). Используется
// только когда кластерных решений нет или запрошен ?source=issues / фильтр стадии.
// Основной путь docx-экспорта — clusterReview.loadClusterDecisions (cluster_id).
async function loadDecisions(tenderId, stageFilter = null) {
  // Только issues АКТУАЛЬНЫХ stage-прогонов (снимок) — архивные не экспортируем.
  const rf = await analysisRuns.issuesRunFilter(tenderId, 'i');
  let sql = `
      SELECT i.*, d.decision as decision_kind, d.final_comment as final_comment, d.edited_redaction as edited_decision_redaction, d.target_text as target_text
      FROM issues i
      LEFT JOIN review_decisions d ON d.issue_id = i.id
      WHERE i.tender_id = ? AND i.selected_for_export = 1
        AND i.review_status IN ('accepted', 'edited')${rf.sql}
  `;
  const params = [tenderId, ...rf.params];
  if (stageFilter) {
    sql += ' AND i.analysis_stage = ?';
    params.push(stageFilter);
  }
  sql += ' ORDER BY i.analysis_stage ASC, i.paragraph_index ASC NULLS LAST, i.char_start ASC NULLS LAST';
  const rows = await db.queryAll(sql, ...params);
  return rows.map((r) => ({
    issue: r,
    decision_kind: r.decision_kind || (r.review_status === 'edited' ? 'edit' : 'accept'),
    // В Word попадает только примечание, явно сохранённое инженером (final_comment).
    // Комментарий анализатора (review_comment) — подсказка в UI, в документ не уходит.
    final_comment: r.final_comment,
    edited_redaction: r.edited_decision_redaction || r.edited_redaction,
    // Подчасть фрагмента (delete/edit на выделенную часть); null = весь фрагмент.
    target_text: r.target_text || null,
  }));
}

// Общая подготовка docx-экспорта: проверки + загрузка решений.
async function prepareDocxExport(tenderId, query) {
  const tender = await db.queryOne('SELECT * FROM tenders WHERE id = ?', tenderId);
  if (!tender) throw notFound('Тендер не найден');
  const tz = await getTzOriginal(tenderId);
  if (!tz) throw badRequest('В тендер не загружен документ типа «ТЗ» (.docx).');
  const ext = path.extname(tz.file_path).toLowerCase();
  if (ext !== '.docx') {
    throw badRequest('Главный экспорт поддерживает только исходный ТЗ в формате .docx. Загрузите ТЗ.docx или используйте HTML-preview.');
  }
  if (!fs.existsSync(tz.file_path)) throw notFound('Файл ТЗ отсутствует на диске');
  const stage = query.stage ? Number(query.stage) : null;

  // Привязка к КОНКРЕТНОЙ согласованной версии (?version_id=): решения берутся
  // из НЕИЗМЕНЯЕМОГО снимка applied_decisions всей цепочки версии, а не из живых
  // review_decisions — экспорт воспроизводим независимо от дальнейшей рецензии.
  if (query.version_id) {
    // eslint-disable-next-line global-require
    const agreedVersions = require('../services/agreedVersion/agreedVersionService');
    const snap = await agreedVersions.loadExportDecisions(tenderId, query.version_id);
    const author = (query.author || tender.owner || 'TZ-Opti').toString();
    return {
      tender, tz, stage: null, decisions: snap.rows, author,
      source: 'agreed_version', agreedVersion: snap.version,
    };
  }

  // Этап 6: основной путь — решения по кластерам (issue_clusters →
  // review_decisions.cluster_id) ПОСЛЕ гейта готовности рецензии: незавершённая
  // рецензия не экспортируется (409 REVIEW_NOT_READY). Пустой список решений
  // legacy-путь НЕ включает: «все замечания отклонены» — валидный завершённый
  // итог (документ без правок). Legacy issue-путь — только явный (?source=issues
  // или ?stage=), для старых тендеров без кластерного конвейера.
  let source = 'clusters';
  let decisions;
  if (isExplicitLegacy(query)) {
    source = 'issues';
    decisions = await loadDecisions(tenderId, stage);
  } else {
    await readiness.assertReviewReady(tenderId, 'экспорт .docx');
    decisions = await clusterReview.loadClusterDecisions(tenderId);
  }

  const author = (query.author || tender.owner || 'TZ-Opti').toString();
  return { tender, tz, stage, decisions, author, source, agreedVersion: null };
}

function setReportHeaders(res, summary) {
  res.setHeader('X-Applied-Count', String(summary.applied));
  res.setHeader('X-Fallback-Count', String(summary.fallback));
  res.setHeader('X-Failed-Count', String(summary.failed));
  res.setHeader('X-Skipped-Count', String(summary.skipped));
}

// Сборка docx-экспорта из решений.
//   source='clusters' — кластер уже является единицей дедупа (разные semantic-bucket
//     кластеры в одном абзаце легитимны), поэтому дедуп НЕ применяется.
//   source='issues'   — legacy-путь: на одно место ТЗ применяется решение primary,
//     дубли уходят в отчёт со статусом skipped (dedupeExportDecisions).
// Возвращает { buffer, report }; report.source проставляется для прозрачности.
function buildDedupedExport(tzPath, decisions, meta, source = 'issues') {
  if (source === 'clusters' || source === 'agreed_version') {
    const { buffer, report } = exportReviewedDocx(tzPath, decisions, meta);
    report.source = source;
    return { buffer, report };
  }
  const { kept, duplicates } = dedupeExportDecisions(decisions);
  const { buffer, report } = exportReviewedDocx(tzPath, kept, meta);
  for (const d of duplicates) {
    report.items.push({
      issueId: d.issue.id,
      stage: d.issue.analysis_stage ?? null,
      decisionKind: d.decision_kind,
      status: 'skipped',
      visual: 'none',
      fallbackUsed: false,
      reason: 'дубликат места — применено решение primary',
    });
    report.summary.skipped += 1;
    report.summary.total += 1;
  }
  report.source = source;
  return { buffer, report };
}

exports.docx = async (req, res) => {
  const { tender, tz, stage, decisions, author, source, agreedVersion } =
    await prepareDocxExport(req.params.id, req.query);
  const { buffer, report } = buildDedupedExport(tz.file_path, decisions, { author, date: new Date() }, source);

  const safeTitle = (tender.title || 'tender').replace(/[^a-zA-Zа-яА-Я0-9_-]+/g, '_').slice(0, 60);
  const suffix = stage ? `__stage${stage}` : (agreedVersion ? `__v${agreedVersion.version_no}` : '');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeTitle)}${suffix}__review.docx"`);
  res.setHeader('X-Export-Source', source);
  if (agreedVersion) res.setHeader('X-Agreed-Version', `${agreedVersion.id}:${agreedVersion.version_no}`);
  setReportHeaders(res, report.summary);
  res.send(buffer);
};

// Dry-run: строит экспорт в памяти и возвращает только JSON-отчёт «что легло /
// через комментарий / не легло / дубликат» — без бинарника. Для показа в портале.
exports.docxReport = async (req, res) => {
  const { tz, decisions, author, source, agreedVersion } = await prepareDocxExport(req.params.id, req.query);
  const { report } = buildDedupedExport(tz.file_path, decisions, { author, date: new Date() }, source);
  const issueById = new Map(decisions.map((d) => [d.issue.id, d.issue]));
  const items = report.items.map((it) => {
    const iss = issueById.get(it.issueId) || {};
    return {
      ...it,
      problem_type: iss.problem_type || null,
      criticality: iss.criticality || null,
      fragment: (iss.source_fragment || '').slice(0, 160),
    };
  });
  res.json({
    summary: report.summary,
    items,
    source,
    agreed_version: agreedVersion ? { id: agreedVersion.id, version_no: agreedVersion.version_no } : null,
  });
};

// CSV/JSON/summary — cluster-primary с issue-fallback (диспетчеры exportService);
// фактический источник виден в X-Export-Source и имени файла.
exports.csv = async (req, res) => {
  if (!isExplicitLegacy(req.query)) await readiness.assertReviewReady(req.params.id, 'экспорт CSV');
  const { content, source } = await exportSvc.exportCsv(req.params.id, { source: req.query.source });
  const prefix = source === 'clusters' ? 'clusters' : 'issues';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${prefix}_${req.params.id}.csv"`);
  res.setHeader('X-Export-Source', source);
  res.send(content);
};

exports.json = async (req, res) => {
  if (!isExplicitLegacy(req.query)) await readiness.assertReviewReady(req.params.id, 'экспорт JSON');
  const { content, source } = await exportSvc.exportJson(req.params.id, { source: req.query.source });
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="analysis_${req.params.id}.json"`);
  res.setHeader('X-Export-Source', source);
  res.send(content);
};

exports.summary = async (req, res) => {
  if (!isExplicitLegacy(req.query)) await readiness.assertReviewReady(req.params.id, 'экспорт summary.md');
  const { content, source } = await exportSvc.exportSummary(req.params.id, { source: req.query.source });
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="summary_${req.params.id}.md"`);
  res.setHeader('X-Export-Source', source);
  res.send(content);
};

exports.reviewMd = async (req, res) => {
  if (!isExplicitLegacy(req.query)) await readiness.assertReviewReady(req.params.id, 'экспорт review.md');
  const stage = req.query.stage ? Number(req.query.stage) : null;
  const md = await renderReviewMd(req.params.id, { stage, source: req.query.source });
  const suffix = stage ? `_stage${stage}` : '';
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="review_${req.params.id}${suffix}.md"`);
  res.send(md);
};
