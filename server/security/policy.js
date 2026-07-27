'use strict';

// Таблица доступа: (метод + путь) → право, действие для аудита и способ
// определить тенант ресурса. Чистый модуль, БД не трогает.
//
// Главное свойство — DEFAULT DENY: путь, для которого нет правила, запрещён
// (403 POLICY_UNMATCHED), а не «раз не описан, значит можно». Новый маршрут без
// строки в этой таблице не заработает, и об этом скажет тест
// security/policyCoverage.test.js, который проходит по ВСЕМ зарегистрированным
// маршрутам приложения.
//
// tenantVia — откуда берётся тенант ресурса для проверки изоляции:
//   tender / document / issue / characteristic / job — из строки БД;
//   principal — коллекция или создание: тенант берётся из токена, а выборка
//               обязана быть отфильтрована по нему в контроллере;
//   system     — глобальный служебный маршрут (нужно право admin.system).

const PARAM_RE = /:([A-Za-z_][A-Za-z0-9_]*)/g;

function compile(template) {
  const names = [];
  const source = template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(PARAM_RE, (_m, name) => {
    names.push(name);
    return '([^/]+)';
  });
  return { re: new RegExp(`^${source}$`), names, template };
}

// r(метод, шаблон, право, действие, категория, откуда тенант, тип ресурса)
function r(method, template, permission, action, category, tenantVia, resourceType) {
  const compiled = compile(template);
  return { method, ...compiled, permission, action, category, tenantVia, resourceType };
}

const READ = 'read';
const WRITE = 'write';
const ANALYSIS = 'analysis';
const DECISION = 'decision';
const EXPORT = 'export';
const ADMIN = 'admin';

// Порядок важен: более специфичные шаблоны идут раньше (/jobs/queue/stats до /jobs/:jobId).
const RULES = [
  // --- служебное ---------------------------------------------------------
  r('GET', '/jobs/queue/stats', 'admin.system', 'queue.stats', ADMIN, 'system', 'queue'),
  r('GET', '/audit', 'audit.read', 'audit.list', ADMIN, 'principal', 'audit'),
  // Физическое удаление истории анализа — только admin.system (см.
  // services/admin/purgeService.js). GET — план (dry-run), POST — удаление.
  r('GET', '/admin/tenders/:tenderId/analysis-history/purge', 'admin.system', 'admin.purge.plan', ADMIN, 'tender', 'analysis_run'),
  r('POST', '/admin/tenders/:tenderId/analysis-history/purge', 'admin.system', 'admin.purge.runs', ADMIN, 'tender', 'analysis_run'),
  r('GET', '/auth/me', 'tender.read', 'auth.me', READ, 'principal', 'principal'),

  // --- тендеры -----------------------------------------------------------
  r('GET', '/tenders', 'tender.read', 'tender.list', READ, 'principal', 'tender'),
  r('POST', '/tenders', 'tender.create', 'tender.create', WRITE, 'principal', 'tender'),
  r('GET', '/tenders/:tenderId', 'tender.read', 'tender.get', READ, 'tender', 'tender'),
  r('PATCH', '/tenders/:tenderId', 'tender.update', 'tender.update', WRITE, 'tender', 'tender'),
  r('DELETE', '/tenders/:tenderId', 'tender.delete', 'tender.delete', WRITE, 'tender', 'tender'),

  // --- документы ---------------------------------------------------------
  r('GET', '/tenders/:tenderId/documents', 'tender.read', 'document.list', READ, 'tender', 'document'),
  r('POST', '/tenders/:tenderId/documents', 'document.upload', 'document.upload', WRITE, 'tender', 'document'),
  r('GET', '/documents/:documentId/download', 'document.read', 'document.download', READ, 'document', 'document'),
  r('GET', '/documents/:documentId/text', 'document.read', 'document.text', READ, 'document', 'document'),
  r('DELETE', '/documents/:documentId', 'document.delete', 'document.delete', WRITE, 'document', 'document'),

  // --- подготовка: чек-лист / условия / риски / параметры / локи ----------
  r('GET', '/tenders/:tenderId/checklist', 'tender.read', 'checklist.list', READ, 'tender', 'checklist'),
  r('POST', '/tenders/:tenderId/checklist', 'setup.write', 'checklist.create', WRITE, 'tender', 'checklist'),
  r('POST', '/tenders/:tenderId/checklist/standard', 'setup.write', 'checklist.reset', WRITE, 'tender', 'checklist'),
  r('PATCH', '/tenders/:tenderId/checklist/:itemId', 'setup.write', 'checklist.update', WRITE, 'tender', 'checklist'),
  r('DELETE', '/tenders/:tenderId/checklist/:itemId', 'setup.write', 'checklist.delete', WRITE, 'tender', 'checklist'),

  r('GET', '/tenders/:tenderId/conditions', 'tender.read', 'conditions.list', READ, 'tender', 'conditions'),
  r('PATCH', '/tenders/:tenderId/conditions/:idx', 'setup.write', 'conditions.update', WRITE, 'tender', 'conditions'),
  r('DELETE', '/tenders/:tenderId/conditions/:idx/override', 'setup.write', 'conditions.override.delete', WRITE, 'tender', 'conditions'),
  r('POST', '/tenders/:tenderId/conditions/reset', 'setup.write', 'conditions.reset', WRITE, 'tender', 'conditions'),

  r('GET', '/tenders/:tenderId/risks', 'tender.read', 'risks.list', READ, 'tender', 'risks'),
  r('GET', '/tenders/:tenderId/risks/matches', 'tender.read', 'risks.matches', READ, 'tender', 'risks'),
  r('POST', '/tenders/:tenderId/risks/reset', 'setup.write', 'risks.reset', WRITE, 'tender', 'risks'),
  r('POST', '/tenders/:tenderId/risks/custom', 'setup.write', 'risks.custom.create', WRITE, 'tender', 'risks'),
  r('DELETE', '/tenders/:tenderId/risks/custom/:customId', 'setup.write', 'risks.custom.delete', WRITE, 'tender', 'risks'),
  r('PATCH', '/tenders/:tenderId/risks/:key', 'setup.write', 'risks.state.update', WRITE, 'tender', 'risks'),

  r('GET', '/tenders/:tenderId/setup/locks', 'tender.read', 'setup.locks.list', READ, 'tender', 'setup'),
  r('POST', '/tenders/:tenderId/setup/:section/lock', 'setup.write', 'setup.lock', WRITE, 'tender', 'setup'),
  r('POST', '/tenders/:tenderId/setup/:section/unlock', 'setup.write', 'setup.unlock', WRITE, 'tender', 'setup'),
  r('GET', '/tenders/:tenderId/setup/params', 'tender.read', 'setup.params.get', READ, 'tender', 'setup'),
  r('PUT', '/tenders/:tenderId/setup/params', 'setup.write', 'setup.params.update', WRITE, 'tender', 'setup'),
  r('GET', '/tenders/:tenderId/setup/params/schema', 'tender.read', 'setup.params.schema', READ, 'tender', 'setup'),

  // --- Q&A и характеристики ---------------------------------------------
  r('POST', '/tenders/:tenderId/qa/import', 'document.upload', 'qa.import', WRITE, 'tender', 'qa'),
  r('POST', '/tenders/:tenderId/qa/auto-link', 'setup.write', 'qa.autolink', WRITE, 'tender', 'qa'),
  r('GET', '/tenders/:tenderId/qa', 'tender.read', 'qa.list', READ, 'tender', 'qa'),
  r('GET', '/tenders/:tenderId/qa/export', 'export.perform', 'qa.export', EXPORT, 'tender', 'qa'),
  r('PATCH', '/tenders/:tenderId/qa/:entryId', 'setup.write', 'qa.update', WRITE, 'tender', 'qa'),
  r('GET', '/tenders/:tenderId/characteristics', 'tender.read', 'characteristics.list', READ, 'tender', 'characteristics'),
  r('POST', '/tenders/:tenderId/characteristics', 'setup.write', 'characteristics.create', WRITE, 'tender', 'characteristics'),
  r('POST', '/tenders/:tenderId/characteristics/seed', 'setup.write', 'characteristics.seed', WRITE, 'tender', 'characteristics'),
  r('PATCH', '/characteristics/:characteristicId', 'setup.write', 'characteristics.update', WRITE, 'characteristic', 'characteristics'),
  r('DELETE', '/characteristics/:characteristicId', 'setup.write', 'characteristics.delete', WRITE, 'characteristic', 'characteristics'),

  // --- ВОР ---------------------------------------------------------------
  r('GET', '/tenders/:tenderId/vor', 'tender.read', 'vor.list', READ, 'tender', 'vor'),
  r('GET', '/tenders/:tenderId/vor/summary', 'tender.read', 'vor.summary', READ, 'tender', 'vor'),
  r('GET', '/tenders/:tenderId/vor/matching', 'tender.read', 'vor.matching', READ, 'tender', 'vor'),
  r('GET', '/tenders/:tenderId/vor/preview', 'tender.read', 'vor.preview', READ, 'tender', 'vor'),
  r('POST', '/tenders/:tenderId/vor/reimport', 'analysis.run', 'vor.reimport', ANALYSIS, 'tender', 'vor'),

  // --- стадии анализа ----------------------------------------------------
  r('GET', '/tenders/:tenderId/stages', 'tender.read', 'stages.state', READ, 'tender', 'stage'),
  r('POST', '/tenders/:tenderId/stages/:stage/run', 'analysis.run', 'stage.run', ANALYSIS, 'tender', 'stage'),
  r('POST', '/tenders/:tenderId/stages/:stage/finish', 'analysis.run', 'stage.finish', ANALYSIS, 'tender', 'stage'),
  r('POST', '/tenders/:tenderId/stages/:stage/reset', 'analysis.run', 'stage.reset', ANALYSIS, 'tender', 'stage'),
  r('GET', '/tenders/:tenderId/stages/:stage/issues', 'tender.read', 'stage.issues', READ, 'tender', 'stage'),
  r('GET', '/tenders/:tenderId/stages/:stage/segments', 'tender.read', 'stage.segments', READ, 'tender', 'stage'),
  r('POST', '/tenders/:tenderId/stages/:stage/segments/:idx/retry', 'analysis.run', 'stage.segment.retry', ANALYSIS, 'tender', 'stage'),

  // --- конвейер: слои ----------------------------------------------------
  r('GET', '/tenders/:tenderId/signals', 'tender.read', 'signals.list', READ, 'tender', 'signals'),
  r('POST', '/tenders/:tenderId/unified/build', 'analysis.run', 'unified.build', ANALYSIS, 'tender', 'draft_issues'),
  r('GET', '/tenders/:tenderId/draft-issues', 'tender.read', 'draft_issues.list', READ, 'tender', 'draft_issues'),
  r('POST', '/tenders/:tenderId/critic/build', 'analysis.run', 'critic.build', ANALYSIS, 'tender', 'issue_reviews'),
  r('GET', '/tenders/:tenderId/issue-reviews', 'tender.read', 'issue_reviews.list', READ, 'tender', 'issue_reviews'),
  r('POST', '/tenders/:tenderId/clustering/build', 'analysis.run', 'clustering.build', ANALYSIS, 'tender', 'issue_clusters'),
  r('GET', '/tenders/:tenderId/issue-clusters', 'tender.read', 'issue_clusters.list', READ, 'tender', 'issue_clusters'),
  r('POST', '/tenders/:tenderId/self-analysis/build', 'analysis.run', 'self_analysis.build', ANALYSIS, 'tender', 'self_analysis'),
  r('GET', '/tenders/:tenderId/self-analysis', 'tender.read', 'self_analysis.list', READ, 'tender', 'self_analysis'),
  r('POST', '/tenders/:tenderId/pipeline/run', 'analysis.run', 'pipeline.run', ANALYSIS, 'tender', 'pipeline'),
  r('GET', '/tenders/:tenderId/pipeline/status', 'tender.read', 'pipeline.status', READ, 'tender', 'pipeline'),

  // --- рецензия и решения ------------------------------------------------
  r('POST', '/tenders/:tenderId/review/clusters/build', 'analysis.run', 'review.clusters.build', ANALYSIS, 'tender', 'cluster'),
  r('GET', '/tenders/:tenderId/review/clusters', 'tender.read', 'review.clusters.list', READ, 'tender', 'cluster'),
  r('GET', '/tenders/:tenderId/review/carryovers', 'tender.read', 'review.carryovers.list', READ, 'tender', 'cluster'),
  r('POST', '/tenders/:tenderId/review/carryovers/confirm', 'decision.write', 'review.carryovers.confirm', DECISION, 'tender', 'cluster'),
  r('GET', '/tenders/:tenderId/review/clusters/:clusterId', 'tender.read', 'review.cluster.get', READ, 'tender', 'cluster'),
  r('POST', '/tenders/:tenderId/review/clusters/:clusterId/decision', 'decision.write', 'review.cluster.decide', DECISION, 'tender', 'cluster'),
  r('GET', '/tenders/:tenderId/review/preview', 'export.perform', 'review.preview', EXPORT, 'tender', 'review'),
  r('GET', '/tenders/:tenderId/review/consolidated', 'tender.read', 'review.consolidated', READ, 'tender', 'review'),
  r('PATCH', '/issues/:issueId', 'decision.write', 'issue.update', DECISION, 'issue', 'issue'),
  r('POST', '/issues/:issueId/decision', 'decision.write', 'issue.decide', DECISION, 'issue', 'issue'),

  // --- выгрузки ----------------------------------------------------------
  r('GET', '/tenders/:tenderId/export/docx', 'export.perform', 'export.docx', EXPORT, 'tender', 'export'),
  r('GET', '/tenders/:tenderId/export/docx/report', 'export.perform', 'export.docx.report', EXPORT, 'tender', 'export'),
  r('GET', '/tenders/:tenderId/export/issues.csv', 'export.perform', 'export.csv', EXPORT, 'tender', 'export'),
  r('GET', '/tenders/:tenderId/export/issues.json', 'export.perform', 'export.json', EXPORT, 'tender', 'export'),
  r('GET', '/tenders/:tenderId/export/summary.md', 'export.perform', 'export.summary_md', EXPORT, 'tender', 'export'),
  r('GET', '/tenders/:tenderId/export/review.md', 'export.perform', 'export.review_md', EXPORT, 'tender', 'export'),

  // --- очередь заданий ---------------------------------------------------
  r('GET', '/tenders/:tenderId/jobs', 'tender.read', 'jobs.list', READ, 'tender', 'job'),
  r('POST', '/tenders/:tenderId/jobs', 'analysis.run', 'jobs.enqueue', ANALYSIS, 'tender', 'job'),
  r('GET', '/jobs/:jobId', 'tender.read', 'jobs.get', READ, 'job', 'job'),
  r('POST', '/jobs/:jobId/cancel', 'analysis.run', 'jobs.cancel', ANALYSIS, 'job', 'job'),
];

// Маршруты без аутентификации. Список закрытый и намеренно короткий.
const PUBLIC_PATHS = new Set(['/health']);

// Путь внутри /api: '/api/tenders/x?y=1' → '/tenders/x'.
function normalizePath(path) {
  const noQuery = String(path || '').split('?')[0];
  const inApi = noQuery.startsWith('/api/') ? noQuery.slice(4) : noQuery === '/api' ? '/' : noQuery;
  if (inApi.length > 1 && inApi.endsWith('/')) return inApi.slice(0, -1);
  return inApi;
}

function isPublicPath(path) {
  return PUBLIC_PATHS.has(normalizePath(path));
}

// (метод, путь) → правило с разобранными параметрами, либо null (= отказ).
function resolvePolicy(method, path) {
  const m = String(method || '').toUpperCase();
  const httpMethod = m === 'HEAD' ? 'GET' : m;
  const p = normalizePath(path);
  for (const rule of RULES) {
    if (rule.method !== httpMethod) continue;
    const match = rule.re.exec(p);
    if (!match) continue;
    const params = {};
    rule.names.forEach((name, i) => {
      params[name] = decodeURIComponent(match[i + 1]);
    });
    return {
      permission: rule.permission,
      action: rule.action,
      category: rule.category,
      tenantVia: rule.tenantVia,
      resourceType: rule.resourceType,
      template: rule.template,
      params,
    };
  }
  return null;
}

module.exports = { resolvePolicy, normalizePath, isPublicPath, RULES, PUBLIC_PATHS };
