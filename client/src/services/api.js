import { authHeaders, notifyUnauthorized } from './auth';

const BASE = '/api';

// Разбор ответа с ошибкой: сервер в production отдаёт общий текст и request_id —
// его показываем инженеру, чтобы поддержка нашла запрос в логе.
async function toError(res) {
  let message = 'Ошибка ' + res.status;
  let data = null;
  try {
    data = await res.json();
  } catch (_e) {
    /* ответ не JSON — остаётся код статуса */
  }
  if (data?.error) message = data.error;
  if (res.status === 403 && data?.code === 'CROSS_TENANT_DENIED') message = 'Доступ к данным другой организации запрещён';
  if (res.status === 429) message = data?.error || 'Слишком много запросов, повторите позже';
  const requestId = data?.request_id || res.headers.get('X-Request-Id');
  const err = new Error(requestId ? `${message} (запрос ${requestId})` : message);
  err.status = res.status;
  err.code = data?.code;
  err.requestId = requestId;
  if (res.status === 401) notifyUnauthorized(err.code);
  return err;
}

async function request(path, { method = 'GET', body, headers, isForm } = {}) {
  const opts = { method, headers: { ...authHeaders(), ...(headers || {}) } };
  if (body !== undefined) {
    if (isForm) {
      opts.body = body;
    } else {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
  }
  const res = await fetch(BASE + path, opts);
  if (!res.ok) throw await toError(res);
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res.text();
}

// Скачивание защищённого файла. Прямая ссылка <a href> не годится: браузер не
// подставит в неё Authorization, и сервер ответит 401. Поэтому файл забираем
// запросом с токеном и сохраняем из памяти.
async function download(path, fallbackName) {
  const res = await fetch(BASE + path, { headers: { ...authHeaders() } });
  if (!res.ok) throw await toError(res);
  const disposition = res.headers.get('Content-Disposition') || '';
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  const name = match ? decodeURIComponent(match[1]) : fallbackName || 'download';
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Освобождаем память после того, как браузер забрал содержимое.
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// Открыть защищённый ресурс в новой вкладке (HTML-предпросмотр рецензии).
async function openInNewTab(path) {
  const res = await fetch(BASE + path, { headers: { ...authHeaders() } });
  if (!res.ok) throw await toError(res);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export const api = {
  // Тендеры
  listTenders: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return request('/tenders' + (q ? '?' + q : ''));
  },
  getTender: (id) => request(`/tenders/${id}`),
  createTender: (data) => request('/tenders', { method: 'POST', body: data }),
  updateTender: (id, data) => request(`/tenders/${id}`, { method: 'PATCH', body: data }),
  deleteTender: (id) => request(`/tenders/${id}`, { method: 'DELETE' }),

  // Документы
  listDocuments: (tenderId) => request(`/tenders/${tenderId}/documents`),
  uploadDocument: (tenderId, file, docType, comment = '') => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('doc_type', docType);
    if (comment) fd.append('comment', comment);
    return request(`/tenders/${tenderId}/documents`, { method: 'POST', body: fd, isForm: true });
  },
  deleteDocument: (id) => request(`/documents/${id}`, { method: 'DELETE' }),
  documentDownloadUrl: (id) => `${BASE}/documents/${id}/download`,

  // Локи разделов подготовки
  getSetupLocks: (tenderId) => request(`/tenders/${tenderId}/setup/locks`),
  lockSetup: (tenderId, section) => request(`/tenders/${tenderId}/setup/${section}/lock`, { method: 'POST' }),
  unlockSetup: (tenderId, section) => request(`/tenders/${tenderId}/setup/${section}/unlock`, { method: 'POST' }),

  // Чек-лист
  listChecklist: (tenderId) => request(`/tenders/${tenderId}/checklist`),
  createChecklist: (tenderId, data) => request(`/tenders/${tenderId}/checklist`, { method: 'POST', body: data }),
  updateChecklist: (tenderId, itemId, data) => request(`/tenders/${tenderId}/checklist/${itemId}`, { method: 'PATCH', body: data }),
  deleteChecklist: (tenderId, itemId) => request(`/tenders/${tenderId}/checklist/${itemId}`, { method: 'DELETE' }),
  resetChecklistToStandard: (tenderId) => request(`/tenders/${tenderId}/checklist/standard`, { method: 'POST' }),

  // Существенные условия — параметрический шаблон
  getSetupParams: (tenderId) => request(`/tenders/${tenderId}/setup/params`),
  updateSetupParams: (tenderId, data) => request(`/tenders/${tenderId}/setup/params`, { method: 'PUT', body: data }),
  getSetupParamsSchema: (tenderId) => request(`/tenders/${tenderId}/setup/params/schema`),

  listConditions: (tenderId) => request(`/tenders/${tenderId}/conditions`),
  patchCondition: (tenderId, idx, data) => request(`/tenders/${tenderId}/conditions/${idx}`, { method: 'PATCH', body: data }),
  removeConditionOverride: (tenderId, idx) => request(`/tenders/${tenderId}/conditions/${idx}/override`, { method: 'DELETE' }),
  resetConditions: (tenderId) => request(`/tenders/${tenderId}/conditions/reset`, { method: 'POST' }),

  // Риски — стандартная библиотека + кастомные + per-tender overlay
  listRisks: (tenderId) => request(`/tenders/${tenderId}/risks`),
  patchRiskState: (tenderId, key, data) => request(`/tenders/${tenderId}/risks/${encodeURIComponent(key)}`, { method: 'PATCH', body: data }),
  resetRisks: (tenderId) => request(`/tenders/${tenderId}/risks/reset`, { method: 'POST' }),
  getRiskMatches: (tenderId) => request(`/tenders/${tenderId}/risks/matches`),
  createCustomRisk: (tenderId, data) => request(`/tenders/${tenderId}/risks/custom`, { method: 'POST', body: data }),
  deleteCustomRisk: (tenderId, customId) => request(`/tenders/${tenderId}/risks/custom/${customId}`, { method: 'DELETE' }),

  // Q&A
  uploadQa: (tenderId, file) => {
    const fd = new FormData();
    fd.append('file', file);
    return request(`/tenders/${tenderId}/qa/import`, { method: 'POST', body: fd, isForm: true });
  },
  listQa: (tenderId) => request(`/tenders/${tenderId}/qa`),
  qaExportUrl: (tenderId) => `${BASE}/tenders/${tenderId}/qa/export`,
  patchQaEntry: (tenderId, entryId, data) => request(`/tenders/${tenderId}/qa/${entryId}`, { method: 'PATCH', body: data }),
  autoLinkQa: (tenderId, opts = {}) => request(`/tenders/${tenderId}/qa/auto-link`, { method: 'POST', body: opts }),
  listCharacteristics: (tenderId) => request(`/tenders/${tenderId}/characteristics`),
  createCharacteristic: (tenderId, data) => request(`/tenders/${tenderId}/characteristics`, { method: 'POST', body: data }),
  seedCharacteristics: (tenderId) => request(`/tenders/${tenderId}/characteristics/seed`, { method: 'POST' }),
  updateCharacteristic: (id, data) => request(`/characteristics/${id}`, { method: 'PATCH', body: data }),
  deleteCharacteristic: (id) => request(`/characteristics/${id}`, { method: 'DELETE' }),

  // Стадии
  getStages: (tenderId) => request(`/tenders/${tenderId}/stages`),
  runStage: (tenderId, n) => request(`/tenders/${tenderId}/stages/${n}/run`, { method: 'POST' }),
  finishStage: (tenderId, n) => request(`/tenders/${tenderId}/stages/${n}/finish`, { method: 'POST' }),
  resetStage: (tenderId, n) => request(`/tenders/${tenderId}/stages/${n}/reset`, { method: 'POST' }),
  listStageIssues: (tenderId, n, params = {}) => {
    const q = new URLSearchParams(params).toString();
    return request(`/tenders/${tenderId}/stages/${n}/issues` + (q ? '?' + q : ''));
  },

  // Части ТЗ (иерархическая token-aware сегментация): статус каждой части и
  // точечный пересчёт одной части вместо повтора всего документа.
  listStageSegments: (tenderId, n) => request(`/tenders/${tenderId}/stages/${n}/segments`),
  retryStageSegment: (tenderId, n, idx) =>
    request(`/tenders/${tenderId}/stages/${n}/segments/${idx}/retry`, { method: 'POST' }),

  // Сигналы (debug-слой новой архитектуры анализа: signals)
  listSignals: (tenderId, signalType = null) =>
    request(`/tenders/${tenderId}/signals${signalType ? `?signal_type=${encodeURIComponent(signalType)}` : ''}`),

  // Единый анализатор ТЗ (debug-слой: draft_issues поверх signals)
  buildDraftIssues: (tenderId) => request(`/tenders/${tenderId}/unified/build`, { method: 'POST' }),
  listDraftIssues: (tenderId) => request(`/tenders/${tenderId}/draft-issues`),

  // Critic (debug-слой: оценка значимости draft_issues для генподрядчика)
  buildIssueReviews: (tenderId) => request(`/tenders/${tenderId}/critic/build`, { method: 'POST' }),
  listIssueReviews: (tenderId, mode = 'working') =>
    request(`/tenders/${tenderId}/issue-reviews?mode=${encodeURIComponent(mode)}`),

  // Clustering (debug-слой: объединение похожих замечаний по одному месту ТЗ)
  buildClusters: (tenderId) => request(`/tenders/${tenderId}/clustering/build`, { method: 'POST' }),
  listClusters: (tenderId, mode = 'working') =>
    request(`/tenders/${tenderId}/issue-clusters?mode=${encodeURIComponent(mode)}`),

  // Self-analysis (debug-слой: QC/полнота над итогом — кластеры + ТЗ, новая роль Стадии 5)
  buildSelfAnalysis: (tenderId) => request(`/tenders/${tenderId}/self-analysis/build`, { method: 'POST' }),
  listSelfAnalysis: (tenderId, findingType = null) =>
    request(`/tenders/${tenderId}/self-analysis${findingType ? `?finding_type=${encodeURIComponent(findingType)}` : ''}`),

  // Pipeline (оркестратор конвейера: draft_issues → critic → clustering → self-analysis)
  runPipeline: (tenderId, { withSelfAnalysis = true } = {}) =>
    request(`/tenders/${tenderId}/pipeline/run`, {
      method: 'POST',
      body: { with_self_analysis: withSelfAnalysis },
    }),
  getPipelineStatus: (tenderId) => request(`/tenders/${tenderId}/pipeline/status`),

  // Решения (legacy issue-level — внутри стадий 1–4)
  patchIssue: (id, data) => request(`/issues/${id}`, { method: 'PATCH', body: data }),
  decideIssue: (id, data) => request(`/issues/${id}/decision`, { method: 'POST', body: data }),

  // Cluster-review (этап 6): issue_clusters — основной объект финальной рецензии.
  buildReviewClusters: (tenderId, force = false) =>
    request(`/tenders/${tenderId}/review/clusters/build${force ? '?force=1' : ''}`, { method: 'POST' }),
  listReviewClusters: (tenderId, mode = 'working') =>
    request(`/tenders/${tenderId}/review/clusters?mode=${encodeURIComponent(mode)}`),
  getReviewCluster: (tenderId, clusterId) =>
    request(`/tenders/${tenderId}/review/clusters/${clusterId}`),
  decideCluster: (tenderId, clusterId, data) =>
    request(`/tenders/${tenderId}/review/clusters/${clusterId}/decision`, { method: 'POST', body: data }),

  // Перенос решений между прогонами (после пересборки): предложения + подтверждение.
  listCarryovers: (tenderId) => request(`/tenders/${tenderId}/review/carryovers`),
  confirmCarryovers: (tenderId, selections) =>
    request(`/tenders/${tenderId}/review/carryovers/confirm`, { method: 'POST', body: { selections } }),

  // Превью + экспорт
  reviewPreviewUrl: (tenderId) => `${BASE}/tenders/${tenderId}/review/preview`,
  // Legacy-fallback: сводный вид по issues (группы находок + конфликты + вердикты).
  // Основной итог экрана «Итог» идёт от кластеров (listReviewClusters); это — back-compat.
  getConsolidated: (tenderId) => request(`/tenders/${tenderId}/review/consolidated`),
  exportDocxUrl: (tenderId, stage = null) =>
    `${BASE}/tenders/${tenderId}/export/docx${stage ? `?stage=${stage}` : ''}`,
  exportCsvUrl: (tenderId) => `${BASE}/tenders/${tenderId}/export/issues.csv`,
  exportJsonUrl: (tenderId) => `${BASE}/tenders/${tenderId}/export/issues.json`,
  exportSummaryUrl: (tenderId) => `${BASE}/tenders/${tenderId}/export/summary.md`,
  exportReviewMdUrl: (tenderId, stage = null) =>
    `${BASE}/tenders/${tenderId}/export/review.md${stage ? `?stage=${stage}` : ''}`,
  // Dry-run отчёт «что попало в Word, а что нет» (без скачивания файла).
  exportDocxReport: (tenderId, stage = null) =>
    request(`/tenders/${tenderId}/export/docx/report${stage ? `?stage=${stage}` : ''}`),

  // --- скачивание защищённых файлов ---------------------------------------
  // Эндпоинты закрыты Bearer-токеном, поэтому файл забирается запросом с
  // заголовком, а не прямой ссылкой (см. download() выше). *Url-хелперы выше
  // оставлены для показа адреса, но переходить по ним напрямую нельзя.
  downloadDocument: (id, name) => download(`/documents/${id}/download`, name),
  downloadQaExport: (tenderId) => download(`/tenders/${tenderId}/qa/export`, 'qa.xlsx'),
  downloadExportDocx: (tenderId, stage = null) =>
    download(`/tenders/${tenderId}/export/docx${stage ? `?stage=${stage}` : ''}`, 'ТЗ-с-правками.docx'),
  downloadExportCsv: (tenderId) => download(`/tenders/${tenderId}/export/issues.csv`, 'issues.csv'),
  downloadExportJson: (tenderId) => download(`/tenders/${tenderId}/export/issues.json`, 'issues.json'),
  downloadExportSummary: (tenderId) => download(`/tenders/${tenderId}/export/summary.md`, 'summary.md'),
  downloadExportReviewMd: (tenderId, stage = null) =>
    download(`/tenders/${tenderId}/export/review.md${stage ? `?stage=${stage}` : ''}`, 'review.md'),
  openReviewPreview: (tenderId) => openInNewTab(`/tenders/${tenderId}/review/preview`),

  // --- субъект и журнал аудита --------------------------------------------
  getMe: () => request('/auth/me'),
  listAudit: (params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== '')).toString();
    return request('/audit' + (q ? '?' + q : ''));
  },
};
