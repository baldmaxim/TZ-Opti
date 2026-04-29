import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTenderStore } from '../store/useTenderStore';
import { useWizardState } from '../hooks/useWizardState';
import { withViewTransition } from '../utils/viewTransition';
import DocumentsPage from './setup/DocumentsPage';
import ChecklistPage from './setup/ChecklistPage';
import ConditionsPage from './setup/ConditionsPage';
import RisksPage from './setup/RisksPage';
import CharacteristicsPage from './setup/CharacteristicsPage';

const PANELS = {
  documents: DocumentsPage,
  checklist: ChecklistPage,
  conditions: ConditionsPage,
  risks: RisksPage,
  characteristics: CharacteristicsPage,
};

const TILES = [
  {
    id: 'documents',
    label: 'Документация',
    to: 'setup/documents',
    accent: 'from-blue-50 to-indigo-50',
    icon: (
      <svg viewBox="0 0 96 96" className="w-20 h-20" fill="none">
        <rect x="22" y="14" width="48" height="62" rx="4" fill="#fff" stroke="#c7d2fe" strokeWidth="1.5" />
        <rect x="28" y="22" width="22" height="3" rx="1.5" fill="#6366f1" />
        <rect x="28" y="30" width="36" height="2" rx="1" fill="#c7d2fe" />
        <rect x="28" y="36" width="30" height="2" rx="1" fill="#c7d2fe" />
        <rect x="28" y="42" width="34" height="2" rx="1" fill="#c7d2fe" />
        <rect x="28" y="48" width="26" height="2" rx="1" fill="#c7d2fe" />
        <circle cx="58" cy="62" r="6" fill="#a5b4fc" opacity="0.5" />
        <rect x="14" y="20" width="48" height="62" rx="4" fill="#eef2ff" stroke="#a5b4fc" strokeWidth="1.5" />
        <circle cx="22" cy="32" r="2.5" fill="#6366f1" />
        <rect x="28" y="30" width="22" height="2" rx="1" fill="#c7d2fe" />
        <rect x="20" y="42" width="34" height="1.5" rx="0.75" fill="#c7d2fe" />
        <rect x="20" y="48" width="30" height="1.5" rx="0.75" fill="#c7d2fe" />
        <rect x="20" y="54" width="26" height="1.5" rx="0.75" fill="#c7d2fe" />
      </svg>
    ),
  },
  {
    id: 'checklist',
    label: 'Состав работ',
    to: 'setup/checklist',
    accent: 'from-emerald-50 to-teal-50',
    icon: (
      <svg viewBox="0 0 96 96" className="w-20 h-20" fill="none">
        <rect x="16" y="14" width="64" height="68" rx="4" fill="#ecfdf5" stroke="#6ee7b7" strokeWidth="1.5" />
        <rect x="22" y="22" width="52" height="6" rx="1.5" fill="#a7f3d0" opacity="0.6" />
        <circle cx="26" cy="36" r="2.5" fill="#10b981" />
        <rect x="32" y="34.5" width="36" height="3" rx="1" fill="#6ee7b7" />
        <circle cx="26" cy="46" r="2.5" fill="#10b981" />
        <rect x="32" y="44.5" width="30" height="3" rx="1" fill="#6ee7b7" />
        <circle cx="26" cy="56" r="2.5" fill="#a7f3d0" />
        <rect x="32" y="54.5" width="34" height="3" rx="1" fill="#a7f3d0" />
        <circle cx="26" cy="66" r="2.5" fill="#a7f3d0" />
        <rect x="32" y="64.5" width="28" height="3" rx="1" fill="#a7f3d0" />
        <path d="M24 36 l1.5 1.5 l3-3" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M24 46 l1.5 1.5 l3-3" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    id: 'conditions',
    label: 'Условия компании',
    to: 'setup/conditions',
    accent: 'from-violet-50 to-purple-50',
    icon: (
      <svg viewBox="0 0 96 96" className="w-20 h-20" fill="none">
        <rect x="20" y="14" width="56" height="64" rx="4" fill="#faf5ff" stroke="#c4b5fd" strokeWidth="1.5" />
        <rect x="28" y="24" width="32" height="3" rx="1.5" fill="#a78bfa" />
        <rect x="28" y="34" width="40" height="2" rx="1" fill="#ddd6fe" />
        <rect x="28" y="40" width="36" height="2" rx="1" fill="#ddd6fe" />
        <rect x="28" y="46" width="38" height="2" rx="1" fill="#ddd6fe" />
        <rect x="28" y="52" width="30" height="2" rx="1" fill="#ddd6fe" />
        <circle cx="62" cy="66" r="10" fill="#ede9fe" stroke="#a78bfa" strokeWidth="1.5" />
        <path d="M58 66 l3 3 l5-6" stroke="#7c3aed" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    id: 'risks',
    label: 'База основных рисков',
    to: 'setup/risks',
    accent: 'from-amber-50 to-orange-50',
    icon: (
      <svg viewBox="0 0 96 96" className="w-20 h-20" fill="none">
        <path d="M48 14 L74 24 V48 C74 64 62 76 48 82 C34 76 22 64 22 48 V24 Z" fill="#fffbeb" stroke="#fcd34d" strokeWidth="1.5" />
        <path d="M48 32 V52" stroke="#f59e0b" strokeWidth="3.5" strokeLinecap="round" />
        <circle cx="48" cy="62" r="2.5" fill="#f59e0b" />
        <path d="M40 22 L64 22" stroke="#fcd34d" strokeWidth="1" opacity="0.5" />
      </svg>
    ),
  },
  {
    id: 'characteristics',
    label: 'Таблица характеристик',
    to: 'setup/characteristics',
    accent: 'from-rose-50 to-pink-50',
    icon: (
      <svg viewBox="0 0 96 96" className="w-20 h-20" fill="none">
        <rect x="16" y="18" width="64" height="60" rx="4" fill="#fff1f2" stroke="#fda4af" strokeWidth="1.5" />
        <rect x="16" y="18" width="64" height="12" rx="4" fill="#fda4af" opacity="0.45" />
        <line x1="42" y1="18" x2="42" y2="78" stroke="#fda4af" strokeWidth="1" />
        <line x1="64" y1="18" x2="64" y2="78" stroke="#fda4af" strokeWidth="1" />
        <line x1="16" y1="42" x2="80" y2="42" stroke="#fda4af" strokeWidth="1" />
        <line x1="16" y1="54" x2="80" y2="54" stroke="#fda4af" strokeWidth="1" />
        <line x1="16" y1="66" x2="80" y2="66" stroke="#fda4af" strokeWidth="1" />
        <rect x="20" y="34" width="18" height="3" rx="1" fill="#e11d48" opacity="0.6" />
        <rect x="46" y="34" width="14" height="3" rx="1" fill="#be185d" opacity="0.55" />
        <rect x="68" y="34" width="9" height="3" rx="1" fill="#be185d" opacity="0.4" />
        <rect x="20" y="46" width="16" height="3" rx="1" fill="#fda4af" />
        <rect x="46" y="46" width="12" height="3" rx="1" fill="#fda4af" />
        <rect x="68" y="46" width="9" height="3" rx="1" fill="#fda4af" />
        <rect x="20" y="58" width="14" height="3" rx="1" fill="#fecdd3" />
        <rect x="46" y="58" width="14" height="3" rx="1" fill="#fecdd3" />
        <rect x="68" y="58" width="9" height="3" rx="1" fill="#fecdd3" />
        <rect x="20" y="70" width="14" height="3" rx="1" fill="#fecdd3" />
        <rect x="46" y="70" width="10" height="3" rx="1" fill="#fecdd3" />
        <rect x="68" y="70" width="9" height="3" rx="1" fill="#fecdd3" />
      </svg>
    ),
  },
];

export default function TenderOverview() {
  const tender = useTenderStore((s) => s.tender);
  const { tenderId } = useWizardState();
  const navigate = useNavigate();
  const [activeTile, setActiveTile] = useState(null);
  const [origins, setOrigins] = useState({}); // id -> "Xpx Ypx"
  const tileRefs = useRef({});
  const panelsWrapperRef = useRef(null);
  const tilesGridRef = useRef(null);
  const lastWheelAtRef = useRef(0);
  const activeTileRef = useRef(null);

  useEffect(() => { activeTileRef.current = activeTile; }, [activeTile]);

  useEffect(() => {
    const node = tilesGridRef.current;
    if (!node) return undefined;
    const onWheel = (e) => {
      if (Math.abs(e.deltaY) < 1 && Math.abs(e.deltaX) < 1) return;
      e.preventDefault();
      const now = Date.now();
      if (now - lastWheelAtRef.current < 250) return;
      const dir = (e.deltaY || e.deltaX) > 0 ? 1 : -1;
      const cur = activeTileRef.current;
      const curIdx = cur ? TILES.findIndex((t) => t.id === cur) : -1;
      let nextIdx;
      if (curIdx === -1) {
        if (dir < 0) return;
        nextIdx = 0;
      } else {
        nextIdx = curIdx + dir;
        if (nextIdx < 0 || nextIdx >= TILES.length) return;
      }
      lastWheelAtRef.current = now;
      const nextId = TILES[nextIdx].id;
      const tileEl = tileRefs.current[nextId];
      const wrapEl = panelsWrapperRef.current;
      if (tileEl && wrapEl) {
        const t = tileEl.getBoundingClientRect();
        const w = wrapEl.getBoundingClientRect();
        const x = t.left + t.width / 2 - w.left;
        const y = t.top + t.height / 2 - w.top;
        setOrigins((prev) => ({ ...prev, [nextId]: `${x}px ${y}px` }));
      }
      setActiveTile(nextId);
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, []);

  if (!tender || !tenderId) return null;

  const total = tender.counts?.issues_total ?? 0;
  const pending = tender.counts?.issues_pending ?? 0;
  const accepted = Math.max(0, total - pending);

  const goBack = () => withViewTransition('back', () => navigate('/'));
  const goAnalysis = () => withViewTransition('forward', () => navigate(`/tenders/${tenderId}/stage/1`));

  const computeOrigin = (id) => {
    const tileEl = tileRefs.current[id];
    const wrapEl = panelsWrapperRef.current;
    if (!tileEl || !wrapEl) return null;
    const t = tileEl.getBoundingClientRect();
    const w = wrapEl.getBoundingClientRect();
    const x = t.left + t.width / 2 - w.left;
    const y = t.top + t.height / 2 - w.top;
    return `${x}px ${y}px`;
  };

  const activateTile = (id) => {
    setActiveTile((cur) => {
      if (cur === id) return cur;
      const next = {};
      if (cur) {
        const o = computeOrigin(cur);
        if (o) next[cur] = o;
      }
      if (id) {
        const o = computeOrigin(id);
        if (o) next[id] = o;
      }
      if (Object.keys(next).length) setOrigins((prev) => ({ ...prev, ...next }));
      return id;
    });
  };

  const toggleTile = (id) => {
    if (activeTile === id) {
      activateTile(null);
    } else {
      activateTile(id);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <button
          type="button"
          onClick={goBack}
          className="inline-flex items-center gap-3 px-7 py-4 rounded-lg text-base font-medium bg-gray-600 text-white hover:bg-gray-500 transition"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 14 4 9l5-5" />
            <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
          </svg>
          К дашборду
        </button>
        <button
          type="button"
          onClick={goAnalysis}
          className="inline-flex items-center gap-3 px-7 py-4 rounded-lg text-base font-medium bg-gray-600 text-white hover:bg-gray-500 transition"
        >
          Анализ ТЗ
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="9" cy="8" r="3" />
            <path d="M3 21v-1a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v1" />
            <circle cx="17" cy="6" r="1.5" fill="currentColor" stroke="none" />
            <circle cx="20.5" cy="3.5" r="0.9" fill="currentColor" stroke="none" />
          </svg>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h14" /><path d="m12 5 7 7-7 7" />
          </svg>
        </button>
      </div>

      <div
        ref={tilesGridRef}
        className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4"
      >
        {TILES.map((t) => {
          const isActive = activeTile === t.id;
          return (
            <button
              key={t.id}
              ref={(el) => { tileRefs.current[t.id] = el; }}
              type="button"
              onClick={() => toggleTile(t.id)}
              aria-expanded={isActive}
              className={`group bg-white border rounded-xl p-5 flex flex-col items-center text-center transition ${
                isActive
                  ? 'border-gray-900 ring-2 ring-gray-900 ring-offset-2'
                  : 'border-gray-200 hover:border-gray-300 hover:shadow-sm'
              }`}
            >
              <div className={`w-full aspect-[4/3] rounded-lg bg-gradient-to-br ${t.accent} flex items-center justify-center mb-3 group-hover:scale-[1.02] transition-transform`}>
                {t.icon}
              </div>
              <div className="text-[15px] font-medium text-gray-800 leading-snug">{t.label}</div>
            </button>
          );
        })}
      </div>

      <div ref={panelsWrapperRef}>
        {TILES.map((t) => {
          const Panel = PANELS[t.id];
          if (!Panel) return null;
          const isActive = activeTile === t.id;
          return (
            <div
              key={t.id}
              className={`tile-panel ${isActive ? 'tile-panel-open' : ''}`}
              aria-hidden={!isActive}
            >
              <div className="tile-panel-inner">
                <div
                  className="tile-card bg-white border border-gray-200 rounded-lg p-6"
                  style={{ transformOrigin: origins[t.id] || 'center top' }}
                >
                  <Panel />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="bg-white border border-gray-200 rounded-lg p-5">
        <h3 className="text-sm font-medium text-gray-500 mb-4">Сводка по замечаниям</h3>
        <div className="grid grid-cols-3 gap-6">
          <div>
            <div className="text-2xl font-semibold tracking-tight text-gray-900 tabular-nums">{total}</div>
            <div className="text-xs text-gray-500 mt-1">Всего</div>
          </div>
          <div>
            <div className="text-2xl font-semibold tracking-tight text-gray-900 tabular-nums">
              {pending}
              {pending > 0 && <span className="ml-2 inline-block w-1.5 h-1.5 rounded-full bg-amber-500 align-middle" />}
            </div>
            <div className="text-xs text-gray-500 mt-1">На рассмотрении</div>
          </div>
          <div>
            <div className="text-2xl font-semibold tracking-tight text-gray-900 tabular-nums">
              {accepted}
              {accepted > 0 && <span className="ml-2 inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 align-middle" />}
            </div>
            <div className="text-xs text-gray-500 mt-1">Обработано</div>
          </div>
        </div>
      </div>
    </div>
  );
}
