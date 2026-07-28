import { useEffect, useState } from 'react';
import { api } from '../../services/api';
import { toastError, toastSuccess } from '../../store/useToastStore';
import { useTenderStore } from '../../store/useTenderStore';
import CandidateRunBanner from '../../components/debug/CandidateRunBanner';

// Debug-вкладка слоя critic: оценка МАТЕРИАЛЬНОСТИ draft_issues для генподрядчика
// (impact × evidence → verdict, см. server/services/review/materiality.js).
// Ничего не удаляется: verify и suppress видны на своих полках с причиной.
// /tenders/:id/debug/issue-reviews

const MODES = [
  { key: 'important', label: 'Только важное', hint: 'publish + влияние critical|high' },
  { key: 'working', label: 'Материальные', hint: 'verdict = publish (что видит инженер)' },
  { key: 'verify', label: 'На проверку', hint: 'verdict = verify (доказательств мало)' },
  { key: 'full', label: 'Полный режим', hint: 'всё, включая скрытое' },
];

const VERDICT_CLASS = {
  publish: 'bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-300',
  verify: 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300',
  suppress: 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400',
};

const PRIORITY_CLASS = {
  critical: 'bg-red-600 text-white',
  high: 'bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-300',
  medium: 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300',
  low: 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400',
};

const IMPACT_CLASS = {
  high: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300',
  medium: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300',
  low: 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400',
  none: 'bg-gray-50 dark:bg-gray-800 text-gray-300',
};

const IMPACT_FIELDS = [
  ['price_impact', 'цена'],
  ['schedule_impact', 'график'],
  ['contract_impact', 'договор'],
  ['responsibility_impact', 'ответств.'],
];

export default function IssueReviewsPage() {
  const tenderId = useTenderStore((s) => s.tenderId);
  const [mode, setMode] = useState('working');
  const [items, setItems] = useState([]);
  const [byPriority, setByPriority] = useState({});
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);

  // Прогон, который смотрим: null — действующий снимок, иначе кандидат от build.
  const [runId, setRunId] = useState(null);

  const load = async (m = mode, rid = runId) => {
    if (!tenderId) return;
    setLoading(true);
    try {
      const res = await api.listIssueReviews(tenderId, m, rid);
      setItems(res.items || []);
      setByPriority(res.by_priority || {});
    } catch (err) { toastError(err.message); }
    setLoading(false);
  };

  useEffect(() => { load(mode); /* eslint-disable-next-line */ }, [tenderId, mode]);

  // Одиночный build — отладочный: пишет в НОВЫЙ кандидат, указатель не переводит.
  const build = async () => {
    if (!tenderId) return;
    setBuilding(true);
    try {
      const res = await api.buildIssueReviews(tenderId);
      const s = res.summary || {};
      toastSuccess(`Critic: оценено ${s.reviewed ?? 0}, показываем ${s.shown ?? 0}, скрыто ${s.hidden ?? 0} `
        + '— в прогоне-кандидате, действующий снимок не изменён');
      setRunId(res.run_id || null);
      await load(mode, res.run_id || null);
    } catch (err) { toastError(err.message); }
    setBuilding(false);
  };

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Critic — значимость замечаний (debug)</h1>
        <div className="flex gap-2">
          <button onClick={() => load()} className="text-sm px-3 py-1 rounded border dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800">
            Обновить
          </button>
          <button
            onClick={build}
            disabled={building}
            className="text-sm px-3 py-1 rounded bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-50"
          >
            {building ? 'Оценка…' : 'Оценить (critic)'}
          </button>
        </div>
      </div>

      <CandidateRunBanner runId={runId} onClear={() => { setRunId(null); load(mode, null); }} />

      <p className="text-sm text-gray-500 dark:text-gray-400">
        Critic считает материальность каждого draft_issue: impact_level — по материальным
        критериям компании (стоимость / срок / оплата / договор / ответственность / объём),
        evidence_level — по структуре находки (привязка к тексту ТЗ, обоснование, число
        независимых сигналов). criticality агента и confidence модели в это НЕ входят.
        Вердикт по матрице impact × evidence: publish — инженер видит по умолчанию,
        verify — на проверку, suppress — скрыто с причиной. Записи не удаляются.
      </p>

      {/* Фильтры-режимы */}
      <div className="flex gap-2">
        {MODES.map((m) => (
          <button
            key={m.key}
            onClick={() => setMode(m.key)}
            className={`text-sm px-3 py-1.5 rounded border dark:border-gray-700 ${
              mode === m.key ? 'bg-gray-900 text-white border-gray-900' : 'bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800'
            }`}
            title={m.hint}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="text-sm text-gray-600 dark:text-gray-400">
        Показано: {items.length}
        {Object.keys(byPriority).length > 0 && (
          <span className="ml-2 text-gray-400 dark:text-gray-500">
            ({Object.entries(byPriority).map(([k, v]) => `${k}: ${v}`).join(', ')})
          </span>
        )}
      </div>

      {loading && <div className="text-gray-500 dark:text-gray-400">Загрузка…</div>}

      {!loading && !items.length && (
        <div className="text-gray-500 dark:text-gray-400">
          Нет оценок в этом режиме. Соберите draft issues (единый анализатор), затем нажмите «Оценить (critic)».
        </div>
      )}

      <div className="space-y-3">
        {items.map((r) => (
          <div
            key={r.id}
            className={`border dark:border-gray-700 rounded p-3 space-y-2 ${r.show_to_engineer ? '' : 'opacity-60 bg-gray-50 dark:bg-gray-800'}`}
          >
            <div className="flex items-center gap-2 flex-wrap">
              {/* Новая модель: вердикт + две оси. display_priority оставлен рядом
                  как легаси-балл сортировки — по нему публикация больше не решается. */}
              {r.verdict && (
                <span className={`text-xs px-2 py-0.5 rounded font-medium ${VERDICT_CLASS[r.verdict] || ''}`}>
                  {r.verdict}
                </span>
              )}
              <span className="text-xs px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200">
                impact: {r.impact_level || '—'} / evidence: {r.evidence_level || '—'}
              </span>
              {Array.isArray(r.impact_dimensions) && r.impact_dimensions.length > 0 && (
                <span className="text-xs px-2 py-0.5 rounded bg-brand-50 dark:bg-brand-900/30 text-brand-700 dark:text-brand-200">
                  {r.impact_dimensions.join(', ')}
                </span>
              )}
              {r.required_action && r.required_action !== 'none' && (
                <span className="text-xs px-2 py-0.5 rounded bg-blue-50 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300">
                  → {r.required_action}
                </span>
              )}
              {/* Precision-критик: исход, кто его принял и по какому правилу. */}
              <span
                className="text-xs px-2 py-0.5 rounded bg-purple-50 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300"
                title="Исход precision-критика (правило / модель)"
              >
                {r.critic_outcome || 'не решено'}
                {r.critic_source ? ` · ${r.critic_source}` : ''}
                {r.critic_assessment?.rule ? ` · ${r.critic_assessment.rule}` : ''}
              </span>
              <span className={`text-xs px-2 py-0.5 rounded font-medium ${PRIORITY_CLASS[r.display_priority] || ''}`} title="Легаси-приоритет сортировки">
                {r.display_priority}
              </span>
              {r.category && <span className="text-xs px-2 py-0.5 rounded bg-blue-50 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300">{r.category}</span>}
              {IMPACT_FIELDS.map(([f, lbl]) => (
                <span key={f} className={`text-xs px-2 py-0.5 rounded ${IMPACT_CLASS[r[f]] || IMPACT_CLASS.none}`}>
                  {lbl}: {r[f]}
                </span>
              ))}
              {r.tz_clause && <span className="text-xs text-gray-400 dark:text-gray-500 truncate max-w-xs">{r.tz_clause}</span>}
            </div>
            {r.source_fragment && (
              <div className="text-sm text-gray-800 dark:text-gray-100 whitespace-pre-wrap line-clamp-2">«{r.source_fragment}»</div>
            )}
            <div className="text-sm text-gray-700 dark:text-gray-300">{r.critic_comment}</div>
            {/* Доводы ПРОТИВ публикации — критик обязан их назвать даже когда публикует. */}
            {Array.isArray(r.critic_assessment?.reasons_against) && r.critic_assessment.reasons_against.length > 0 && (
              <ul className="text-xs text-gray-500 dark:text-gray-400 list-disc pl-5">
                {r.critic_assessment.reasons_against.map((x, i) => <li key={i}>{x}</li>)}
              </ul>
            )}
            {r.critic_assessment && (
              <div className="text-xs text-gray-400 dark:text-gray-500 font-mono">
                {['evidence_strength', 'business_consequence', 'actionability', 'novelty',
                  'scope_impact', 'cost_impact', 'schedule_impact', 'contract_impact', 'responsibility_impact']
                  .map((k) => `${k}=${r.critic_assessment[k]}`).join(' · ')}
              </div>
            )}
            {Array.isArray(r.criteria) && r.criteria.length > 0 && (
              <div className="text-xs text-gray-400 dark:text-gray-500 font-mono">критерии: {r.criteria.join(', ')}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
