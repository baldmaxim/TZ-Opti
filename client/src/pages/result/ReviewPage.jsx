// Страница инженерной проверки замечаний ИИ (этап «Рецензия»).
//
// Две панели: слева исходный текст ТЗ с подсвеченной цитатой выбранного
// замечания, справа — компактный список + карточка замечания. Вкладки по
// полкам материальности, верхняя панель статистики, горячие клавиши
// (A/E/R/V + стрелки), режим «Только существенные».
//
// Qualification gate — SHADOW MODE: его классификация показывается в карточке
// как рекомендация, но production-статус замечания меняют только явные
// действия инженера (Принять / Принять с изменением / Отклонить и действия
// с текстом ТЗ). «На проверку», «Объединить» и «Изменить приоритет» пишутся
// только в shadow-слой (finding_qualification_decisions) — состав и статус
// замечаний не трогают. Вся чистая логика — utils/reviewBoard.js.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../services/api';
import { toastError, toastSuccess, toastWarning } from '../../store/useToastStore';
import { useTenderStore } from '../../store/useTenderStore';
import { useWizardState } from '../../hooks/useWizardState';
import EmptyState from '../../components/ui/EmptyState';
import GateNotice from '../../components/wizard/GateNotice';
import CarryoverPanel from '../../components/review/CarryoverPanel';
import AgreedVersionsPanel from '../../components/review/AgreedVersionsPanel';
import ReviewTabs from '../../components/review/ReviewTabs';
import ReviewStatsBar from '../../components/review/ReviewStatsBar';
import DocumentPane from '../../components/review/DocumentPane';
import FindingList from '../../components/review/FindingList';
import FindingCard from '../../components/review/FindingCard';
import DecisionDialog from '../../components/review/DecisionDialog';
import { clusterTopic, truncate } from '../../utils/format';
import {
  buildSearchIndex,
  computeStats,
  decisionStateOf,
  hotkeyAction,
  locateQuote,
  moveIndex,
  nextUndecidedIndex,
  packReviewState,
  productionPayloadFor,
  reviewStateKey,
  shadowPayloadFor,
  tabCounts,
  unpackReviewState,
  validateDecisionForm,
  visibleClusters,
} from '../../utils/reviewBoard';

// Диалог нужен для действий с причиной/параметрами; accept и defer — мгновенные.
const DIALOG_ACTIONS = ['reject', 'edit', 'merge', 'priority'];

const quoteOf = (cluster) => {
  if (!cluster) return '';
  const primary = (cluster.items || []).find((it) => it.item_role === 'primary');
  return cluster.representative_fragment || (primary && primary.source_fragment) || '';
};

export default function ReviewPage() {
  const tenderId = useTenderStore((s) => s.tenderId);
  const decideCluster = useTenderStore((s) => s.decideCluster);
  const { steps } = useWizardState();
  const reviewStep = steps.find((s) => s.id === 'review');

  const [clusters, setClusters] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [building, setBuilding] = useState(false);
  const [carryKey, setCarryKey] = useState(0);

  // Shadow-слой gate: оценки + актуальные решения инженера по ним.
  const [gateById, setGateById] = useState(new Map());
  const [shadowById, setShadowById] = useState(new Map());
  const [gateRunId, setGateRunId] = useState(null);

  // Текст ТЗ для левой панели.
  const [docText, setDocText] = useState('');
  const [docStatus, setDocStatus] = useState('loading');

  // Фильтры, вкладка и позиция — восстанавливаются per пользователь+тендер+прогон.
  const [tab, setTab] = useState('critical');
  const [essential, setEssential] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [userKey, setUserKey] = useState('anon');
  const [stateReady, setStateReady] = useState(false);

  const [dialog, setDialog] = useState(null); // { action } | null
  const [busy, setBusy] = useState(false);

  const runId = gateRunId || (clusters[0] && clusters[0].analysis_run_id) || null;
  const storageKey = reviewStateKey(tenderId, runId, userKey);

  // --- Загрузка данных -------------------------------------------------------

  const loadClusters = useCallback(async () => {
    if (!tenderId) return;
    try {
      const data = await api.listReviewClusters(tenderId, 'full');
      setClusters(data.items || []);
      setLoaded(true);
    } catch (err) { toastError(err.message); }
  }, [tenderId]);

  const loadGate = useCallback(async () => {
    if (!tenderId) return;
    try {
      const q = await api.listQualification(tenderId);
      const gates = new Map();
      const shadows = new Map();
      for (const it of q.items || []) {
        gates.set(it.cluster_id, it);
        if (it.engineer_decision) shadows.set(it.cluster_id, it.engineer_decision);
      }
      setGateById(gates);
      setShadowById(shadows);
      setGateRunId(q.run_id || null);
    } catch (_err) {
      // Shadow-слой недоступен — страница полноценно работает без него.
    }
  }, [tenderId]);

  const loadDoc = useCallback(async () => {
    if (!tenderId) return;
    setDocStatus('loading');
    try {
      const docs = await api.listDocuments(tenderId);
      const tzMd = (docs.items || []).find(
        (d) => d.doc_type === 'tz' && /\.md$/i.test(d.name || ''),
      );
      if (!tzMd) { setDocStatus('missing'); return; }
      const res = await api.getDocumentText(tzMd.id);
      setDocText(res.extracted_text || '');
      setDocStatus('ready');
    } catch (_err) { setDocStatus('missing'); }
  }, [tenderId]);

  useEffect(() => {
    if (reviewStep?.status === 'locked' || !tenderId) return;
    loadClusters();
    loadGate();
    loadDoc();
    api.getMe()
      .then((me) => setUserKey(me.subject || me.sub || me.email || 'anon'))
      .catch(() => {});
  }, [tenderId, reviewStep?.status, loadClusters, loadGate, loadDoc]);

  // --- Восстановление и сохранение состояния просмотра -----------------------

  useEffect(() => {
    if (!loaded || stateReady) return;
    try {
      const saved = unpackReviewState(localStorage.getItem(storageKey));
      setTab(saved.tab);
      setEssential(saved.essential);
      if (saved.selected_id) setSelectedId(saved.selected_id);
    } catch (_e) { /* дефолты уже стоят */ }
    setStateReady(true);
  }, [loaded, stateReady, storageKey]);

  useEffect(() => {
    if (!stateReady) return;
    try {
      localStorage.setItem(storageKey, packReviewState({ tab, essential, selected_id: selectedId }));
    } catch (_e) { /* хранилище недоступно — состояние живёт в памяти вкладки */ }
  }, [tab, essential, selectedId, stateReady, storageKey]);

  // --- Производные данные ----------------------------------------------------

  const essentialBase = useMemo(
    () => visibleClusters(clusters, { tab: 'all', essential }),
    [clusters, essential],
  );
  const counts = useMemo(() => tabCounts(essentialBase), [essentialBase]);
  const visible = useMemo(
    () => visibleClusters(clusters, { tab, essential }),
    [clusters, tab, essential],
  );
  const stats = useMemo(
    () => computeStats(clusters, shadowById, gateById),
    [clusters, shadowById, gateById],
  );
  const stateById = useMemo(() => {
    const m = new Map();
    for (const c of clusters) m.set(c.id, decisionStateOf(c, shadowById.get(c.id) || null));
    return m;
  }, [clusters, shadowById]);

  // Выбранное замечание всегда из видимого списка.
  const selectedIndex = visible.findIndex((c) => c.id === selectedId);
  const selected = selectedIndex >= 0 ? visible[selectedIndex] : null;
  useEffect(() => {
    if (!stateReady) return;
    if (!selected && visible.length) setSelectedId(visible[0].id);
    if (selected === null && !visible.length && selectedId) setSelectedId(null);
  }, [stateReady, selected, visible, selectedId]);

  // Подсветка цитаты в документе (индекс строится один раз на текст).
  const docIndex = useMemo(() => (docText ? buildSearchIndex(docText) : null), [docText]);
  const selectedQuote = quoteOf(selected);
  const highlight = useMemo(() => {
    if (!selected || !docIndex || !selectedQuote) return null;
    return locateQuote(docText, selectedQuote, docIndex);
  }, [selected, docIndex, docText, selectedQuote]);

  // --- Действия --------------------------------------------------------------

  const navigate = useCallback((delta) => {
    if (!visible.length) return;
    const next = moveIndex(visible.length, selectedIndex, delta);
    if (next >= 0) setSelectedId(visible[next].id);
  }, [visible, selectedIndex]);

  // Выполнить решение: production-слой (если применимо) + shadow-слой gate.
  const performAction = useCallback(async (action, form = {}) => {
    if (!selected) return;
    const check = validateDecisionForm(action, form);
    if (!check.ok) { toastError(check.error); return; }
    setBusy(true);
    try {
      const prodPayload = productionPayloadFor(action, form);
      if (prodPayload) {
        const res = await decideCluster(selected.id, prodPayload);
        const dec = res?.decision || { decision: prodPayload.decision, ...prodPayload };
        setClusters((prev) => prev.map((c) => (c.id === selected.id ? { ...c, decision: dec } : c)));
        setCarryKey((k) => k + 1);
      }
      const mergeTarget = form.mergeTargetId
        ? clusters.find((c) => c.id === form.mergeTargetId)
        : null;
      const shadowPayload = shadowPayloadFor(action, form, {
        mergeTargetLabel: mergeTarget
          ? truncate(clusterTopic(mergeTarget) || mergeTarget.cluster_title || mergeTarget.id, 80)
          : null,
        currentPriority: selected.overall_impact_level || selected.overall_criticality || null,
      });
      if (shadowPayload) {
        try {
          const res = await api.overrideQualification(tenderId, selected.id, shadowPayload);
          const saved = res?.decision || shadowPayload;
          setShadowById((prev) => new Map(prev).set(selected.id, saved));
        } catch (err) {
          // Production-решение уже сохранено; сбой shadow-слоя не блокирует работу.
          if (prodPayload) toastWarning(`Решение сохранено, но shadow-слой gate недоступен: ${err.message}`);
          else throw err;
        }
      }
      toastSuccess('Решение сохранено');
      setDialog(null);
      // Автопереход к следующему необработанному замечанию.
      const next = nextUndecidedIndex(
        visible,
        selectedIndex,
        (c) => c.id === selected.id || !!decisionStateOf(c, shadowById.get(c.id) || null),
      );
      if (next != null) setSelectedId(visible[next].id);
    } catch (err) {
      toastError(err.message);
    } finally {
      setBusy(false);
    }
  }, [selected, selectedIndex, visible, clusters, shadowById, tenderId, decideCluster]);

  const onAction = useCallback((action) => {
    if (!selected || busy) return;
    if (DIALOG_ACTIONS.includes(action)) setDialog({ action });
    else performAction(action, {});
  }, [selected, busy, performAction]);

  // --- Горячие клавиши -------------------------------------------------------

  const hotkeyCtx = useRef(null);
  hotkeyCtx.current = { onAction, navigate, dialogOpen: !!dialog, busy };
  useEffect(() => {
    const onKey = (e) => {
      const ctx = hotkeyCtx.current;
      if (!ctx || ctx.dialogOpen || ctx.busy) return;
      const action = hotkeyAction(e);
      if (!action) return;
      e.preventDefault();
      if (action === 'next') ctx.navigate(1);
      else if (action === 'prev') ctx.navigate(-1);
      else ctx.onAction(action);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // --- Пересборка итога ------------------------------------------------------

  const build = async () => {
    setBuilding(true);
    try {
      await api.buildReviewClusters(tenderId, true);
      await Promise.all([loadClusters(), loadGate()]);
      setCarryKey((k) => k + 1);
      toastSuccess('Итог собран');
    } catch (err) { toastError(err.message); }
    setBuilding(false);
  };

  if (reviewStep?.status === 'locked') return <GateNotice stepId="review" />;
  if (!tenderId) return null;

  const mergeCandidates = visible
    .map((c, i) => ({ id: c.id, index: i, cluster: c }))
    .filter((c) => !selected || c.id !== selected.id);

  return (
    <div className="space-y-3">
      {/* Шапка: вкладки + пересборка */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ReviewTabs active={tab} counts={counts} onChange={setTab} />
        <button className="btn btn-secondary text-xs" disabled={building} onClick={build}>
          {building ? 'Собираю…' : 'Пересобрать итог'}
        </button>
      </div>

      <ReviewStatsBar
        stats={stats}
        essential={essential}
        hiddenByEssential={clusters.length - essentialBase.length}
        onToggleEssential={() => setEssential((v) => !v)}
      />

      <CarryoverPanel key={carryKey} tenderId={tenderId} onConfirmed={() => loadClusters()} />

      <AgreedVersionsPanel
        tenderId={tenderId}
        decidedCount={clusters.filter((c) => c.decision).length}
        onChanged={() => loadClusters()}
      />

      {clusters.length === 0 ? (
        <EmptyState
          title={loaded ? 'Кластеры ещё не собраны' : 'Загрузка…'}
          description={loaded
            ? 'Соберите итог из находок стадий 1–4 — конвейер сгруппирует замечания по местам ТЗ.'
            : ''}
          action={loaded ? (
            <button className="btn btn-primary" disabled={building} onClick={build}>
              {building ? 'Собираю…' : 'Собрать итог'}
            </button>
          ) : null}
        />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] gap-3">
          {/* Левая панель: исходный текст ТЗ с подсветкой цитаты */}
          <div className="lg:sticky lg:top-2 h-[45vh] lg:h-[calc(100vh-16rem)] min-h-[280px]">
            <DocumentPane
              text={docText}
              status={docStatus}
              highlight={highlight}
              hasQuote={!!selectedQuote}
              quoteFound={!selectedQuote || !!highlight}
            />
          </div>

          {/* Правая панель: список + карточка выбранного замечания */}
          <div className="flex flex-col gap-3 min-h-0">
            {visible.length === 0 ? (
              <EmptyState
                title="На этой вкладке пусто"
                description={essential
                  ? 'Действует фильтр «Только существенные» — снимите его в панели выше или переключите вкладку.'
                  : 'Переключите вкладку — замечания лежат на других полках, ничего не удалено.'}
              />
            ) : (
              <>
                <FindingList
                  items={visible}
                  selectedId={selectedId}
                  stateById={stateById}
                  gateById={gateById}
                  onSelect={setSelectedId}
                />
                {selected && (
                  <FindingCard
                    cluster={selected}
                    index={selectedIndex}
                    total={visible.length}
                    gate={gateById.get(selected.id) || null}
                    state={stateById.get(selected.id) || null}
                    quoteFound={!selectedQuote || !!highlight}
                    busy={busy}
                    onAction={onAction}
                    onNavigate={navigate}
                  />
                )}
              </>
            )}
          </div>
        </div>
      )}

      <DecisionDialog
        open={!!dialog}
        action={dialog ? dialog.action : null}
        cluster={selected}
        candidates={mergeCandidates}
        busy={busy}
        onSubmit={performAction}
        onClose={() => setDialog(null)}
      />
    </div>
  );
}
