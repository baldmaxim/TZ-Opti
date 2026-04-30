import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTenderStore } from '../../store/useTenderStore';
import { useWizardState } from '../../hooks/useWizardState';
import { withViewTransition } from '../../utils/viewTransition';
import StagePanel from './StagePanel';
import ResultPanel from './ResultPanel';

const TILES = [
  {
    id: 'stage1',
    stage: 1,
    label: 'Стадия 1',
    sublabel: 'ТЗ + Чек-лист + ВОР',
    accent: 'from-blue-50 to-indigo-50',
    icon: (
      <svg viewBox="0 0 96 96" className="w-20 h-20" fill="none">
        <rect x="18" y="14" width="60" height="68" rx="4" fill="#eef2ff" stroke="#a5b4fc" strokeWidth="1.5" />
        <rect x="26" y="22" width="34" height="3" rx="1.5" fill="#6366f1" />
        <circle cx="28" cy="36" r="2.5" fill="#6366f1" />
        <rect x="34" y="34.5" width="34" height="3" rx="1" fill="#a5b4fc" />
        <circle cx="28" cy="46" r="2.5" fill="#6366f1" />
        <rect x="34" y="44.5" width="30" height="3" rx="1" fill="#a5b4fc" />
        <circle cx="28" cy="56" r="2.5" fill="#a5b4fc" />
        <rect x="34" y="54.5" width="32" height="3" rx="1" fill="#c7d2fe" />
        <circle cx="28" cy="66" r="2.5" fill="#a5b4fc" />
        <rect x="34" y="64.5" width="26" height="3" rx="1" fill="#c7d2fe" />
        <path d="M26 36 l1.5 1.5 l3-3" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M26 46 l1.5 1.5 l3-3" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    id: 'stage2',
    stage: 2,
    label: 'Стадия 2',
    sublabel: 'Q&A + Характеристики',
    accent: 'from-emerald-50 to-teal-50',
    icon: (
      <svg viewBox="0 0 96 96" className="w-20 h-20" fill="none">
        <path d="M20 26 C20 22 23 19 27 19 H59 C63 19 66 22 66 26 V48 C66 52 63 55 59 55 H38 L28 64 V55 H27 C23 55 20 52 20 48 Z" fill="#ecfdf5" stroke="#6ee7b7" strokeWidth="1.5" />
        <path d="M37 33 C37 30 39 28 42 28 C45 28 47 30 47 33 C47 35 45 36 43 38 C42 39 42 40 42 42" stroke="#10b981" strokeWidth="2" strokeLinecap="round" fill="none" />
        <circle cx="42" cy="47" r="1.5" fill="#10b981" />
        <rect x="50" y="58" width="30" height="22" rx="3" fill="#d1fae5" stroke="#6ee7b7" strokeWidth="1.5" />
        <line x1="50" y1="65" x2="80" y2="65" stroke="#6ee7b7" strokeWidth="1" />
        <line x1="60" y1="58" x2="60" y2="80" stroke="#6ee7b7" strokeWidth="1" />
        <line x1="70" y1="58" x2="70" y2="80" stroke="#6ee7b7" strokeWidth="1" />
      </svg>
    ),
  },
  {
    id: 'stage3',
    stage: null,
    placeholder: true,
    label: 'Стадия 3',
    sublabel: 'Существенные условия',
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
    id: 'stage4',
    stage: 3,
    label: 'Стадия 4',
    sublabel: 'Типовые риски',
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
    id: 'stage5',
    stage: 4,
    label: 'Стадия 5',
    sublabel: 'Самоанализ ТЗ',
    accent: 'from-cyan-50 to-sky-50',
    icon: (
      <svg viewBox="0 0 96 96" className="w-20 h-20" fill="none">
        <circle cx="42" cy="42" r="20" fill="#ecfeff" stroke="#67e8f9" strokeWidth="1.5" />
        <path d="M58 58 L74 74" stroke="#0891b2" strokeWidth="3" strokeLinecap="round" />
        <circle cx="42" cy="42" r="12" fill="#cffafe" stroke="#22d3ee" strokeWidth="1" />
        <path d="M37 38 Q42 33 47 38" stroke="#0891b2" strokeWidth="1.5" fill="none" strokeLinecap="round" />
        <circle cx="38" cy="42" r="1.5" fill="#0891b2" />
        <circle cx="46" cy="42" r="1.5" fill="#0891b2" />
        <path d="M37 47 Q42 50 47 47" stroke="#0891b2" strokeWidth="1.5" fill="none" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'result',
    stage: null,
    label: 'Результат',
    sublabel: 'Рецензия и экспорт',
    accent: 'from-rose-50 to-pink-50',
    icon: (
      <svg viewBox="0 0 96 96" className="w-20 h-20" fill="none">
        <rect x="22" y="14" width="48" height="62" rx="4" fill="#fff1f2" stroke="#fda4af" strokeWidth="1.5" />
        <rect x="28" y="22" width="22" height="3" rx="1.5" fill="#e11d48" />
        <rect x="28" y="32" width="36" height="2" rx="1" fill="#fecdd3" />
        <rect x="28" y="40" width="32" height="2" rx="1" fill="#fecdd3" />
        <rect x="28" y="48" width="34" height="2" rx="1" fill="#fecdd3" />
        <rect x="28" y="56" width="28" height="2" rx="1" fill="#fecdd3" />
        <circle cx="58" cy="68" r="8" fill="#fce7f3" stroke="#f9a8d4" strokeWidth="1.5" />
        <path d="M55 68 l2.5 2.5 l4-5" stroke="#be185d" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
];

export default function AnalysisOverview() {
  const tender = useTenderStore((s) => s.tender);
  const tenderId = useTenderStore((s) => s.tenderId);
  const navigate = useNavigate();
  const { steps } = useWizardState();

  const [activeTile, setActiveTile] = useState(null);
  const [origins, setOrigins] = useState({});
  const tileRefs = useRef({});
  const panelsWrapperRef = useRef(null);

  if (!tender || !tenderId) return null;

  const backendStepStatus = (backendStage) => {
    if (backendStage == null) return 'available';
    return steps.find((s) => s.id === `stage${backendStage}`)?.status || 'available';
  };
  const stageFinished = (backendStage) => backendStepStatus(backendStage) === 'finished';
  const tileStatus = (tile) => {
    if (tile.placeholder) {
      // Stage 3 (заглушка) — открывается только после Stage 2 (backend 2).
      return stageFinished(2) ? 'available' : 'locked';
    }
    if (tile.id === 'result') {
      // Результат — после завершения всех 4 реальных стадий анализа.
      const allDone = [1, 2, 3, 4].every((n) => stageFinished(n));
      return allDone ? 'available' : 'locked';
    }
    return backendStepStatus(tile.stage);
  };
  const isLocked = (tile) => tileStatus(tile) === 'locked';

  const goOverview = () => withViewTransition('back', () => navigate(`/tenders/${tenderId}`));

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

  const toggleTile = (tile) => {
    if (isLocked(tile)) return;
    if (activeTile === tile.id) activateTile(null);
    else activateTile(tile.id);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={goOverview}
          className="inline-flex items-center gap-3 px-7 py-4 rounded-lg text-base font-medium bg-gray-600 text-white hover:bg-gray-500 transition"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 14 4 9l5-5" />
            <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
          </svg>
          К обзору
        </button>
        <h1 className="flex-1 text-center text-lg font-semibold text-gray-900 truncate min-w-0 px-2" title={tender.title}>
          {tender.title}
        </h1>
        <span aria-hidden="true" className="invisible inline-flex items-center gap-3 px-7 py-4 text-base font-medium">
          К обзору
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
        {TILES.map((t) => {
          const isActive = activeTile === t.id;
          const locked = isLocked(t);
          const status = tileStatus(t);
          return (
            <button
              key={t.id}
              ref={(el) => { tileRefs.current[t.id] = el; }}
              type="button"
              onClick={() => toggleTile(t)}
              disabled={locked}
              aria-expanded={isActive}
              className={`group bg-white border rounded-xl p-5 flex flex-col items-center text-center transition ${
                isActive
                  ? 'border-gray-900 ring-2 ring-gray-900 ring-offset-2'
                  : locked
                    ? 'border-gray-200 opacity-50 cursor-not-allowed'
                    : 'border-gray-200 hover:border-gray-300 hover:shadow-sm'
              }`}
            >
              <div className={`w-full aspect-[4/3] rounded-lg bg-gradient-to-br ${t.accent} flex items-center justify-center mb-3 transition-transform duration-300 ease-out ${
                isActive ? 'scale-[1.04]' : !locked && 'group-hover:scale-[1.02]'
              }`}>
                <span className={`inline-block transition-transform duration-300 ease-out ${
                  isActive ? 'scale-[1.35]' : !locked && 'group-hover:scale-[1.05]'
                }`}>
                  {t.icon}
                </span>
              </div>
              <div className="text-[15px] font-medium text-gray-800 leading-snug">{t.label}</div>
              <div className="text-[11px] text-gray-500 mt-0.5 leading-tight">{t.sublabel}</div>
              {status === 'finished' && (
                <div className="text-[10px] mt-1 text-emerald-700 font-medium">✓ завершено</div>
              )}
              {status === 'locked' && (
                <div className="text-[10px] mt-1 text-gray-400">🔒 заблокировано</div>
              )}
            </button>
          );
        })}
      </div>

      <div ref={panelsWrapperRef}>
        {TILES.map((t) => {
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
                  {t.id === 'result' ? (
                    <ResultPanel />
                  ) : t.placeholder ? (
                    <div className="text-center py-12">
                      <h2 className="font-semibold text-lg">{t.label}: {t.sublabel}</h2>
                      <p className="text-sm text-gray-600 mt-2">
                        Анализ ТЗ против ваших существенных условий компании —
                        ищет в тексте противоречия и пропуски относительно 28 пунктов из вкладки «Условия компании».
                      </p>
                      <p className="text-xs text-amber-700 mt-4 inline-block bg-amber-50 border border-amber-200 rounded px-3 py-1.5">
                        🚧 В разработке. Анализ скоро будет добавлен.
                      </p>
                    </div>
                  ) : (
                    <StagePanel stage={t.stage} />
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
