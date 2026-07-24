import { useEffect, useState } from 'react';
import { api } from '../../services/api';
import { criticalityClass, CRITICALITY, DECISIONS, formatProblemType } from '../../utils/labels';
import { formatTzClause, clusterTopic, humanizeNote } from '../../utils/format';
import { toastError, toastSuccess } from '../../store/useToastStore';
import EmptyState from '../../components/ui/EmptyState';
import { useTenderStore } from '../../store/useTenderStore';
import { useWizardState } from '../../hooks/useWizardState';
import GateNotice from '../../components/wizard/GateNotice';
import CarryoverPanel from '../../components/review/CarryoverPanel';

// Что именно ляжет в Word по выбранному решению (зеркало server/review/decisionModel.js).
const EXPORT_HINT = {
  accept: 'Примечание — Word-комментарий',
  edit: 'Замена — Track Changes (w:del + w:ins)',
  delete: 'Удаление — Track Changes (w:del)',
  remove_from_scope: 'Удаление + метка «Вынесено из объёма ГП»',
  reject: 'Не экспортируется',
};

const FINDING_LABEL = {
  missed_coverage: 'Возможный пропуск',
  weak_cluster: 'Слабый кластер',
  cluster_contradiction: 'Противоречие кластеров',
  needs_enrichment: 'Можно усилить',
};

// Кнопки решений: по умолчанию нейтральные (btn-secondary), выбранное решение
// подсвечивается заливкой + кольцом — чтобы было видно, что выбрал инженер.
const DECISION_BUTTONS = [
  { key: 'reject', label: 'Отклонить', active: 'bg-gray-700 text-white ring-2 ring-offset-1 ring-gray-400 dark:ring-gray-600' },
  { key: 'edit', label: 'Принять с правкой', active: 'bg-blue-600 text-white ring-2 ring-offset-1 ring-blue-300' },
  { key: 'accept', label: 'Принять', active: 'bg-green-600 text-white ring-2 ring-offset-1 ring-green-300' },
  { key: 'remove_from_scope', label: 'Вынести из объёма', active: 'bg-amber-500 text-white ring-2 ring-offset-1 ring-amber-300' },
  { key: 'delete', label: 'Удалить из ТЗ', active: 'bg-red-600 text-white ring-2 ring-offset-1 ring-red-300' },
];

// Главный (наиболее значимый) элемент кластера — у него берём отрывок ТЗ и краткое
// основание для шапки карточки.
function pickPrimaryItem(items) {
  return items.find((it) => it.item_role === 'primary') || items[0] || null;
}

function ClusterCard({ index, cluster, onDecide }) {
  const decided = cluster.decision || null;
  // Поле инженера НЕ префиллим вариантом ИИ — стартует пустым (или из решения).
  const [red, setRed] = useState(decided?.edited_redaction ?? '');
  const [com, setCom] = useState(decided?.final_comment ?? '');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const decide = async (decision) => {
    setBusy(true);
    try {
      await onDecide(cluster.id, { decision, edited_redaction: red, final_comment: com });
    } finally {
      setBusy(false);
    }
  };

  const items = cluster.items || [];
  const notes = cluster.self_analysis || [];
  const primary = pickPrimaryItem(items);
  const aiVariant = humanizeNote(cluster.merged_recommendation || '');
  const shortDescription = humanizeNote((primary && primary.basis) || clusterTopic(cluster) || '—');
  const clause = formatTzClause(cluster.tz_clause);

  return (
    <div className="card p-4 space-y-3">
      {/* 1. Шапка: номер + критичность + краткая тема + статус решения. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-base font-bold text-gray-900 dark:text-gray-100">№{index}</span>
        <span className={`tag ${criticalityClass(cluster.overall_criticality)}`}>
          {CRITICALITY[cluster.overall_criticality] || cluster.overall_criticality}
        </span>
        <span className="font-semibold text-sm">{clusterTopic(cluster)}</span>
        {!cluster.show_to_engineer && (
          <span className="tag bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 text-xs">малозначимо</span>
        )}
        {decided && (
          <span className="tag bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-300 text-xs">
            Решение: {DECISIONS[decided.decision] || decided.decision}
          </span>
        )}
      </div>

      {/* 2. Место в ТЗ: компактная локация + дословный отрывок (главный ориентир). */}
      <div>
        <div className="label">Место в ТЗ</div>
        {clause && <div className="text-xs text-gray-500 dark:text-gray-400">{clause}</div>}
        {primary && primary.source_fragment && (
          <div className="mt-1 p-3 bg-gray-50 dark:bg-gray-800 border-l-2 dark:border-gray-700 border-gray-300 dark:border-gray-700 rounded text-sm text-gray-700 dark:text-gray-300 italic whitespace-pre-wrap">
            «{primary.source_fragment}»
          </div>
        )}
      </div>

      {/* 3. Краткое описание замечания. */}
      <div>
        <div className="label">Замечание</div>
        <div className="text-sm text-gray-800 dark:text-gray-100 whitespace-pre-wrap">{shortDescription}</div>
      </div>

      {/* 4. Вариант от Агента ИИ (read-only) + кнопка «Взять в правку». */}
      <div>
        <div className="flex items-center justify-between gap-2">
          <div className="label mb-0">Вариант от ИИ — как лучше исправить</div>
          <button
            type="button"
            className="btn btn-secondary text-xs py-1"
            disabled={!aiVariant}
            onClick={() => setRed(aiVariant)}
          >
            Взять в правку →
          </button>
        </div>
        <div className="mt-1 p-3 bg-blue-50 dark:bg-blue-900/40 border dark:border-gray-700 border-blue-100 dark:border-blue-800 rounded text-sm text-gray-800 dark:text-gray-100 whitespace-pre-wrap">
          {aiVariant || 'ИИ не предложил конкретной правки.'}
        </div>
      </div>

      {/* 5. Ручной ввод инженера. */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <div className="label">Текст правки в ТЗ</div>
          <textarea
            className="input min-h-[88px]"
            placeholder="Ваш вариант редакции (или нажмите «Взять в правку»)"
            value={red}
            onChange={(e) => setRed(e.target.value)}
          />
        </div>
        <div>
          <div className="label">Комментарий для Word</div>
          <textarea
            className="input min-h-[88px]"
            placeholder="Пояснение, которое уйдёт в Word-комментарий"
            value={com}
            onChange={(e) => setCom(e.target.value)}
          />
        </div>
      </div>

      {/* 6. Решения: нейтральные по умолчанию, подсвечивается только выбранное. */}
      <div className="flex flex-wrap items-center gap-2 justify-end pt-1 border-t dark:border-gray-700">
        {DECISION_BUTTONS.map((b) => {
          const selected = decided?.decision === b.key;
          return (
            <button
              key={b.key}
              className={`btn ${selected ? b.active : 'btn-secondary'}`}
              disabled={busy}
              onClick={() => decide(b.key)}
            >
              {b.label}
            </button>
          );
        })}
      </div>
      {decided && (
        <div className="text-xs text-gray-500 dark:text-gray-400 text-right">
          В экспорт: {EXPORT_HINT[decided.decision] || '—'}
        </div>
      )}

      {/* 7. Подробности (свёрнуто): основание, исходные сигналы, самоанализ. */}
      <div className="border-t dark:border-gray-700 pt-2">
        <button
          type="button"
          className="text-xs text-brand-600 hover:underline"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? '▾ Скрыть подробности' : '▸ Подробнее'} (основание, сигналы стадий, самоанализ)
        </button>
        {open && (
          <div className="mt-2 space-y-3">
            <div>
              <div className="label">Объединённое основание</div>
              <div className="p-3 bg-gray-50 dark:bg-gray-800 border dark:border-gray-700 rounded text-sm whitespace-pre-wrap">
                {cluster.merged_basis || '—'}
              </div>
            </div>

            <div>
              <div className="label">Исходные замечания и сигналы ({items.length})</div>
              <div className="space-y-2">
                {items.map((it) => (
                  <div key={it.draft_issue_id} className="text-xs border dark:border-gray-700 rounded p-2 bg-white dark:bg-gray-800">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`tag text-[10px] ${it.item_role === 'primary' ? 'bg-brand-100 text-brand-800' : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400'}`}>
                        {it.item_role === 'primary' ? 'основной' : 'связанный'}
                      </span>
                      {it.category && <span className="text-gray-500 dark:text-gray-400">[{it.category}]</span>}
                      {it.problem_type && <span className="text-gray-600 dark:text-gray-400">{formatProblemType(it.problem_type)}</span>}
                    </div>
                    {it.basis && <div className="text-gray-700 dark:text-gray-300">{it.basis}</div>}
                    {it.source_fragment && (
                      <div className="text-gray-500 dark:text-gray-400 mt-1 italic">«{it.source_fragment}»</div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {notes.length > 0 && (
              <div>
                <div className="label">Самоанализ (Стадия 5)</div>
                <div className="space-y-1">
                  {notes.map((n) => (
                    <div key={n.id} className="text-xs p-2 rounded bg-amber-50 dark:bg-amber-900/40 border dark:border-gray-700 border-amber-100 dark:border-amber-800">
                      <span className="font-medium text-amber-800 dark:text-amber-300">{FINDING_LABEL[n.finding_type] || n.finding_type}:</span>{' '}
                      <span className="text-gray-700 dark:text-gray-300">{n.comment}</span>
                      {n.suggested_improvement && (
                        <div className="text-gray-600 dark:text-gray-400 mt-0.5">→ {n.suggested_improvement}</div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function ReviewPage() {
  const tenderId = useTenderStore((s) => s.tenderId);
  const decideCluster = useTenderStore((s) => s.decideCluster);
  const { steps } = useWizardState();
  const reviewStep = steps.find((s) => s.id === 'review');

  const [clusters, setClusters] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [building, setBuilding] = useState(false);
  const [mode, setMode] = useState('working');
  // Меняется после пересборки/решения — перечитывает предложения переноса решений.
  const [carryKey, setCarryKey] = useState(0);

  const load = async (m = mode) => {
    if (!tenderId) return;
    try {
      const data = await api.listReviewClusters(tenderId, m);
      setClusters(data.items || []);
      setLoaded(true);
    } catch (err) { toastError(err.message); }
  };

  useEffect(() => {
    if (reviewStep?.status === 'locked') return;
    load();
    /* eslint-disable-next-line */
  }, [tenderId, reviewStep?.status]);

  const build = async () => {
    setBuilding(true);
    try {
      await api.buildReviewClusters(tenderId, true);
      await load();
      setCarryKey((k) => k + 1); // новый прогон — обновить предложения переноса
      toastSuccess('Итог собран');
    } catch (err) { toastError(err.message); }
    setBuilding(false);
  };

  const onDecide = async (clusterId, payload) => {
    try {
      const res = await decideCluster(clusterId, payload);
      setClusters((prev) =>
        prev.map((c) => (c.id === clusterId ? { ...c, decision: res?.decision || { decision: payload.decision, ...payload } } : c)),
      );
      setCarryKey((k) => k + 1); // решённый кластер выбывает из предложений переноса
      toastSuccess('Решение сохранено');
    } catch (err) { toastError(err.message); }
  };

  const switchMode = async (m) => {
    setMode(m);
    await load(m);
  };

  if (reviewStep?.status === 'locked') {
    return <GateNotice stepId="review" />;
  }

  const decidedCount = clusters.filter((c) => c.decision).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm text-gray-600 dark:text-gray-400">
            Рецензия по сгруппированным замечаниям (кластерам). Одно решение на кластер — оно и попадёт в экспорт.
          </div>
          {clusters.length > 0 && (
            <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">Обработано: {decidedCount} из {clusters.length}</div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded border dark:border-gray-700 overflow-hidden text-xs">
            <button className={`px-2 py-1 ${mode === 'working' ? 'bg-brand-600 text-white' : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400'}`} onClick={() => switchMode('working')}>Значимые</button>
            <button className={`px-2 py-1 ${mode === 'full' ? 'bg-brand-600 text-white' : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400'}`} onClick={() => switchMode('full')}>Все</button>
          </div>
          <button className="btn btn-secondary text-xs" disabled={building} onClick={build}>
            {building ? 'Собираю…' : 'Пересобрать итог'}
          </button>
        </div>
      </div>

      {/* Перенос решений из прошлого прогона (виден только при наличии предложений). */}
      <CarryoverPanel
        key={carryKey}
        tenderId={tenderId}
        onConfirmed={() => load()}
      />

      {clusters.length === 0 ? (
        <EmptyState
          title={loaded ? 'Кластеры ещё не собраны' : 'Загрузка…'}
          description={loaded ? 'Соберите итог из находок стадий 1–4 — конвейер сгруппирует замечания по местам ТЗ.' : ''}
          action={loaded ? <button className="btn btn-primary" disabled={building} onClick={build}>{building ? 'Собираю…' : 'Собрать итог'}</button> : null}
        />
      ) : (
        clusters.map((c, i) => <ClusterCard key={c.id} index={i + 1} cluster={c} onDecide={onDecide} />)
      )}
    </div>
  );
}
