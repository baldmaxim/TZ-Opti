import { Link } from 'react-router-dom';
import clsx from 'clsx';
import StepStatus from '../layout/StepStatus';
import { stepRoute } from '../../utils/wizardSteps';

export default function SectionRollup({ section, tenderId }) {
  const items = section.items || [];
  return (
    <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 border-gray-200 dark:border-gray-700 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          <span className="text-gray-400 dark:text-gray-500 mr-1.5">{section.order}</span>
          {section.label}
        </h3>
        <span className="text-xs text-gray-500 dark:text-gray-400 tabular-nums">{section.finished}/{section.total}</span>
      </div>
      <ul className="space-y-0.5">
        {items.map((step) => {
          const locked = step.status === 'locked';
          const finished = step.status === 'finished';
          return (
            <li key={step.id}>
              <Link
                to={stepRoute(step, tenderId)}
                className={clsx(
                  'flex items-center gap-2 px-2 py-1.5 -mx-2 rounded text-sm transition',
                  'hover:bg-gray-50 dark:hover:bg-gray-800',
                  locked && 'opacity-60'
                )}
              >
                <StepStatus status={step.status} label={step.label} />
                <span className={clsx('flex-1 truncate', finished ? 'text-gray-500 dark:text-gray-400' : 'text-gray-800 dark:text-gray-100')}>
                  {step.shortLabel || step.label}
                </span>
                {step.badge != null && (
                  <span className="text-[11px] font-medium text-gray-500 dark:text-gray-400 tabular-nums flex-shrink-0">
                    {step.badge}
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
