import { create } from 'zustand';
import { api } from '../services/api';
import { toastError, toastSuccess } from './useToastStore';
import { analysisStartKey } from '../components/stages/AnalysisProgressRing';

// Реестр активных опросов (вне store — реактивность не нужна), ключ
// `${tenderId}:${stage}`. Стадия 1 считается в фоне на сервере; клиент
// опрашивает /stages, пока status==='running'.
const activePolls = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const useTenderStore = create((set, get) => ({
  tenderId: null,
  tender: null,
  loading: false,
  stages: null,
  stageState: null,
  documents: [],
  hasTz: false,
  hasQa: false,
  // Оркестрация единого «Анализа ТЗ» (новая архитектура): под капотом прогоняет
  // добытчики стадий 1–4 и пересобирает конвейер до кластеров, но наружу — один блок.
  analysisRunning: false,
  analysisStep: null,

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
      // Авто-возобновление опроса: если стадия считается (например, страницу
      // перезагрузили во время 15-мин анализа) — продолжаем следить.
      for (const s of data.stages || []) {
        if (data.state?.[`stage${s.stage}_status`] === 'running') {
          get()._pollStage(s.stage);
        }
      }
    } catch (err) {
      toastError(err.message);
    }
  },

  // Опрос статуса фоновой стадии до завершения. Идемпотентен (один опрос
  // на tender:stage). Закрытие вкладки опрос прервёт, но сервер досчитает —
  // при следующем заходе refreshStages возобновит слежение.
  async _pollStage(n) {
    const id = get().tenderId;
    if (!id) return;
    const key = `${id}:${n}`;
    if (activePolls.has(key)) return;
    activePolls.add(key);
    try {
      for (;;) {
        // 3с (а не 7с): чтобы кольцо прогресса быстро обновлялось и сразу исчезало
        // по завершении стадии (раньше при 7с бар «залипал» на устаревшем значении).
        await sleep(3000);
        if (get().tenderId !== id) return; // ушли на другой тендер
        let data;
        try {
          data = await api.getStages(id);
        } catch {
          continue; // временная сетевая ошибка — продолжаем опрос
        }
        set({ stages: data.stages, stageState: data.state });
        const st = data.state?.[`stage${n}_status`];
        if (st !== 'running') {
          const info = (data.stages || []).find((s) => s.stage === n);
          const sm = info && info.summary;
          if (sm && sm.status === 'failed') {
            toastError(
              `Стадия ${n}: анализ не удался — ${
                (sm.summary && sm.summary.error) || 'см. логи'
              }. Повторите запуск.`,
            );
          } else {
            toastSuccess(`Стадия ${n}: анализ завершён`);
          }
          return;
        }
      }
    } finally {
      activePolls.delete(key);
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
    // Фиксируем момент старта для круговой шкалы прогресса (сервер не пишет
    // analysis_runs для идущего прогона). Сбрасывается на каждый новый запуск.
    try { localStorage.setItem(analysisStartKey(id, n), String(Date.now())); } catch { /* ignore */ }
    // Сервер отвечает сразу (202 {status:'running'}) или кидает 400
    // (уже идёт / стадия недоступна) — её обработает вызывающий.
    const result = await api.runStage(id, n);
    await get().refreshStages(); // сервер уже выставил 'running'
    get()._pollStage(n); // следим за фоновым прогоном (без await)
    return result;
  },

  async finishStage(n) {
    const id = get().tenderId;
    if (!id) return null;
    const result = await api.finishStage(id, n);
    await Promise.all([get().refreshStages(), get().refreshTender()]);
    return result;
  },

  // Ждёт завершения фонового прогона стадии n (status !== 'running'). Возвращает
  // последний снимок /stages. Используется оркестратором runAnalysis.
  async _waitStage(n) {
    const id = get().tenderId;
    if (!id) return null;
    for (;;) {
      await sleep(3000);
      if (get().tenderId !== id) return null;
      let data;
      try { data = await api.getStages(id); } catch { continue; }
      set({ stages: data.stages, stageState: data.state });
      if (data.state?.[`stage${n}_status`] !== 'running') return data;
    }
  },

  // Единый «Анализ ТЗ»: последовательно прогоняет добытчиков стадий 1–4 (сервер
  // оставлен как есть — гейт «следующая после finish»), затем пересобирает конвейер
  // signals → draft_issues → critic → clustering (опц. self-analysis). Best-effort:
  // если шаг недоступен/падает — собираем кластеры из того, что уже есть.
  async runAnalysis({ withSelfAnalysis = false } = {}) {
    const id = get().tenderId;
    if (!id) return null;
    set({ analysisRunning: true, analysisStep: 'Подготовка…' });
    try {
      await get().refreshStages();
      for (let n = 1; n <= 4; n += 1) {
        const statusOf = () => get().stageState?.[`stage${n}_status`];
        if (statusOf() === 'finished') continue;
        set({ analysisStep: `Добыча замечаний: шаг ${n} из 4` });
        if (statusOf() !== 'running') {
          try {
            try { localStorage.setItem(analysisStartKey(id, n), String(Date.now())); } catch { /* ignore */ }
            await api.runStage(id, n);
          } catch (err) {
            // Гейт «стадия недоступна» / уже идёт — прекращаем добычу, идём к сборке.
            toastError(`Шаг ${n}: ${err.message}`);
            break;
          }
        }
        await get()._waitStage(n);
        try { await api.finishStage(id, n); } catch { /* best-effort */ }
        await get().refreshStages();
      }
      set({ analysisStep: 'Сборка кластеров…' });
      await api.runPipeline(id, { withSelfAnalysis });
      await Promise.all([get().refreshStages(), get().refreshTender()]);
      toastSuccess('Анализ ТЗ собран');
      return { ok: true };
    } catch (err) {
      toastError(err.message);
      return { ok: false, error: err.message };
    } finally {
      set({ analysisRunning: false, analysisStep: null });
    }
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

  // Cluster-review (этап 6): решение по кластеру. Не трогает стадии/issues —
  // основной путь рецензии поверх issue_clusters.
  async decideCluster(clusterId, payload) {
    const id = get().tenderId;
    if (!id) return null;
    return api.decideCluster(id, clusterId, payload);
  },

  async patchIssue(issueId, patch) {
    const result = await api.patchIssue(issueId, patch);
    await get().refreshTender();
    return result;
  },
}));
