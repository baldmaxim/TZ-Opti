import clsx from 'clsx';
import { STAGE_STATUS } from '../../utils/labels';

export default function StageStepper({ stages = [], activeStage, onChange }) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {stages.map((s, idx) => {
        const isActive = activeStage === s.stage;
        const finished = s.status === 'finished';
        const locked = s.status === 'locked';
        return (
          <div key={s.stage} className="flex items-center gap-2">
            <button
              onClick={() => !locked && onChange && onChange(s.stage)}
              disabled={locked}
              className={clsx(
                'flex items-center gap-2 px-3 py-2 rounded-md border text-sm transition',
                isActive ? 'border-brand-600 bg-brand-50 text-brand-900' : 'border-gray-200 bg-white text-gray-700',
                locked ? 'opacity-50 cursor-not-allowed' : 'hover:border-brand-400'
              )}
            >
              <span className={clsx(
                'flex items-center justify-center w-7 h-7 rounded-full text-xs font-semibold',
                finished ? 'bg-green-600 text-white' : isActive ? 'bg-brand-600 text-white' : 'bg-gray-200 text-gray-600'
              )}>{finished ? '✓' : s.stage}</span>
              <div className="text-left">
                <div className="font-medium leading-tight">Стадия {s.stage}</div>
                <div className="text-xs text-gray-500">{STAGE_STATUS[s.status] || s.status}</div>
              </div>
            </button>
            {idx < stages.length - 1 && <div className="h-px w-6 bg-gray-300" />}
          </div>
        );
      })}
    </div>
  );
}
