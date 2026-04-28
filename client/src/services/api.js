const BASE = '/api';

async function request(path, { method = 'GET', body, headers, isForm } = {}) {
  const opts = { method, headers: { ...(headers || {}) } };
  if (body !== undefined) {
    if (isForm) {
      opts.body = body;
    } else {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
  }
  const res = await fetch(BASE + path, opts);
  if (!res.ok) {
    let err = 'Ошибка ' + res.status;
    try { const data = await res.json(); err = data.error || err; } catch (_e) { /* ignore */ }
    throw new Error(err);
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res.text();
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
  listCharacteristics: (tenderId) => request(`/tenders/${tenderId}/characteristics`),
  updateCharacteristic: (id, data) => request(`/characteristics/${id}`, { method: 'PATCH', body: data }),

  // Стадии
  getStages: (tenderId) => request(`/tenders/${tenderId}/stages`),
  runStage: (tenderId, n) => request(`/tenders/${tenderId}/stages/${n}/run`, { method: 'POST' }),
  finishStage: (tenderId, n) => request(`/tenders/${tenderId}/stages/${n}/finish`, { method: 'POST' }),
  resetStage: (tenderId, n) => request(`/tenders/${tenderId}/stages/${n}/reset`, { method: 'POST' }),
  listStageIssues: (tenderId, n, params = {}) => {
    const q = new URLSearchParams(params).toString();
    return request(`/tenders/${tenderId}/stages/${n}/issues` + (q ? '?' + q : ''));
  },

  // Решения
  patchIssue: (id, data) => request(`/issues/${id}`, { method: 'PATCH', body: data }),
  decideIssue: (id, data) => request(`/issues/${id}/decision`, { method: 'POST', body: data }),

  // Превью + экспорт
  reviewPreviewUrl: (tenderId) => `${BASE}/tenders/${tenderId}/review/preview`,
  exportDocxUrl: (tenderId) => `${BASE}/tenders/${tenderId}/export/docx`,
  exportCsvUrl: (tenderId) => `${BASE}/tenders/${tenderId}/export/issues.csv`,
  exportJsonUrl: (tenderId) => `${BASE}/tenders/${tenderId}/export/issues.json`,
  exportSummaryUrl: (tenderId) => `${BASE}/tenders/${tenderId}/export/summary.md`,
};
