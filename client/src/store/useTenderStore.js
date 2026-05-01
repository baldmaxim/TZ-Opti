import { create } from 'zustand';
import { api } from '../services/api';
import { toastError } from './useToastStore';

export const useTenderStore = create((set, get) => ({
  tenderId: null,
  tender: null,
  loading: false,
  stages: null,
  stageState: null,
  documents: [],
  hasTz: false,
  hasQa: false,

  async setTender(id) {
    if (get().tenderId === id) return;
    set({ tenderId: id, tender: null, stages: null, documents: [], hasTz: false, hasQa: false });
    await get().refreshTender();
    await get().refreshStages();
    await get().refreshDocuments();
  },

  async refreshTender() {
    const id = get().tenderId;
    if (!id) return;
    set({ loading: true });
    try {
      const tender = await api.getTender(id);
      set({ tender, loading: false });
    } catch (err) {
      toastError(err.message);
      set({ loading: false });
    }
  },

  async refreshStages() {
    const id = get().tenderId;
    if (!id) return;
    try {
      const data = await api.getStages(id);
      set({ stages: data.stages, stageState: data.state });
    } catch (err) {
      toastError(err.message);
    }
  },

  async refreshDocuments() {
    const id = get().tenderId;
    if (!id) return;
    try {
      const data = await api.listDocuments(id);
      const items = data.items || [];
      set({
        documents: items,
        hasTz: items.some((d) => d.doc_type === 'tz'),
        hasQa: items.some((d) => d.doc_type === 'qa'),
      });
    } catch (err) {
      toastError(err.message);
    }
  },

  async update(patch) {
    const id = get().tenderId;
    const next = await api.updateTender(id, patch);
    set({ tender: next });
  },

  async runStage(n) {
    const id = get().tenderId;
    if (!id) return null;
    const result = await api.runStage(id, n);
    await get().refreshStages();
    return result;
  },

  async finishStage(n) {
    const id = get().tenderId;
    if (!id) return null;
    const result = await api.finishStage(id, n);
    await Promise.all([get().refreshStages(), get().refreshTender()]);
    return result;
  },

  async resetStage(n) {
    const id = get().tenderId;
    if (!id) return null;
    const result = await api.resetStage(id, n);
    await Promise.all([get().refreshStages(), get().refreshTender()]);
    return result;
  },

  async decideIssue(issueId, payload) {
    const result = await api.decideIssue(issueId, payload);
    await Promise.all([get().refreshStages(), get().refreshTender()]);
    return result;
  },

  async patchIssue(issueId, patch) {
    const result = await api.patchIssue(issueId, patch);
    await get().refreshTender();
    return result;
  },
}));
