import { useNavigate } from 'react-router-dom';
import { useTenderStore } from '../store/useTenderStore';
import { useWizardState } from '../hooks/useWizardState';
import { withViewTransition } from '../utils/viewTransition';

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
    id: 'qa',
    label: 'Q&A форма',
    to: 'setup/qa',
    accent: 'from-rose-50 to-pink-50',
    icon: (
      <svg viewBox="0 0 96 96" className="w-20 h-20" fill="none">
        <path d="M20 26 C20 22 23 19 27 19 H59 C63 19 66 22 66 26 V48 C66 52 63 55 59 55 H38 L28 64 V55 H27 C23 55 20 52 20 48 Z" fill="#fff1f2" stroke="#fda4af" strokeWidth="1.5" />
        <path d="M37 33 C37 30 39 28 42 28 C45 28 47 30 47 33 C47 35 45 36 43 38 C42 39 42 40 42 42" stroke="#e11d48" strokeWidth="2" strokeLinecap="round" fill="none" />
        <circle cx="42" cy="47" r="1.5" fill="#e11d48" />
        <path d="M76 38 C76 35 73 32 69 32 H58 C54 32 51 35 51 38 V58 C51 61 54 64 58 64 H62 L70 72 V64 H69 C73 64 76 61 76 58 Z" fill="#fce7f3" stroke="#f9a8d4" strokeWidth="1.5" />
        <text x="63" y="52" fontSize="14" fontWeight="700" fill="#be185d" textAnchor="middle">A</text>
      </svg>
    ),
  },
];

export default function TenderOverview() {
  const tender = useTenderStore((s) => s.tender);
  const { tenderId } = useWizardState();
  const navigate = useNavigate();

  if (!tender || !tenderId) return null;

  const total = tender.counts?.issues_total ?? 0;
  const pending = tender.counts?.issues_pending ?? 0;
  const accepted = Math.max(0, total - pending);

  const goBack = () => withViewTransition('back', () => navigate('/'));
  const goAnalysis = () => withViewTransition('forward', () => navigate(`/tenders/${tenderId}/stage/1`));
  const goTile = (to) => withViewTransition('forward', () => navigate(`/tenders/${tenderId}/${to}`));

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

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
        {TILES.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => goTile(t.to)}
            className="group bg-white border border-gray-200 rounded-xl p-5 flex flex-col items-center text-center hover:border-gray-300 hover:shadow-sm transition"
          >
            <div className={`w-full aspect-[4/3] rounded-lg bg-gradient-to-br ${t.accent} flex items-center justify-center mb-3 group-hover:scale-[1.02] transition-transform`}>
              {t.icon}
            </div>
            <div className="text-[15px] font-medium text-gray-800 leading-snug">{t.label}</div>
          </button>
        ))}
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
