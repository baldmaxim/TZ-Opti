import { create } from 'zustand';

export const useToastStore = create((set, get) => ({
  toasts: [],
  push(message, type = 'info') {
    const id = Math.random().toString(36).slice(2);
    set((s) => ({ toasts: [...s.toasts, { id, message, type }] }));
    setTimeout(() => {
      const next = get().toasts.filter((t) => t.id !== id);
      set({ toasts: next });
    }, 4500);
  },
  remove(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));

export const toastSuccess = (m) => useToastStore.getState().push(m, 'success');
export const toastError = (m) => useToastStore.getState().push(m, 'error');
export const toastInfo = (m) => useToastStore.getState().push(m, 'info');
