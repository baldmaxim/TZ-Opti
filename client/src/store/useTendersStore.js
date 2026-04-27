import { create } from 'zustand';
import { api } from '../services/api';
import { toastError } from './useToastStore';

export const useTendersStore = create((set) => ({
  items: [],
  loading: false,
  filters: { search: '', status: '', type: '' },
  setFilter(name, value) {
    set((s) => ({ filters: { ...s.filters, [name]: value } }));
  },
  async load() {
    set({ loading: true });
    try {
      const params = {};
      const f = useTendersStore.getState().filters;
      if (f.search) params.search = f.search;
      if (f.status) params.status = f.status;
      if (f.type) params.type = f.type;
      const data = await api.listTenders(params);
      set({ items: data.items || [], loading: false });
    } catch (err) {
      toastError(err.message);
      set({ loading: false });
    }
  },
  async create(data) {
    const t = await api.createTender(data);
    await useTendersStore.getState().load();
    return t;
  },
  async remove(id) {
    await api.deleteTender(id);
    await useTendersStore.getState().load();
  },
}));
