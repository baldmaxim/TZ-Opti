import { Link } from 'react-router-dom';
import clsx from 'clsx';
import StepStatus from '../layout/StepStatus';
import { stepRoute } from '../../utils/wizardSteps';

export default function SectionRollup({ section, tenderId }) {
  const items = section.items || [];
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-base">
          {section.order}. {section.label}
        </h3>
        <span className="text-sm text-gray-500">{section.finished} / {section.total}</span>
      </div>
      <ul className="space-y-1.5">
        {items.map((step) => {
          const locked = step.status === 'locked';
          const finished = step.status === 'finished';
          return (
            <li key={step.id}>
              <Link
                to={stepRoute(step, tenderId)}
                className={clsx(
                  'flex items-center gap-2 px-2 py-1.5 rounded text-sm transition',
                  'hover:bg-gray-50',
                  locked && 'opacity-60'
                )}
              >
                <StepStatus status={step.status} label={step.label} />
                <span className={clsx('flex-1 truncate', finished ? 'text-gray-700' : 'text-gray-800')}>
                  {step.shortLabel || step.label}
                </span>
                {step.badge != null && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-gray-100 text-gray-600 flex-shrink-0">
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
