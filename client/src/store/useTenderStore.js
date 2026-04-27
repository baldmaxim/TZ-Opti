import { create } from 'zustand';
import { api } from '../services/api';
import { toastError } from './useToastStore';

export const useTenderStore = create((set, get) => ({
  tenderId: null,
  tender: null,
  loading: false,
  stages: null,
  stageState: null,
  async setTender(id) {
    if (get().tenderId === id) return;
    set({ tenderId: id, tender: null, stages: null });
    await get().refreshTender();
    await get().refreshStages();
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
  async update(patch) {
    const id = get().tenderId;
    const next = await api.updateTender(id, patch);
    set({ tender: next });
  },
}));
