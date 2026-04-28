import { NavLink, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { useWizardState } from '../../hooks/useWizardState';
import { stepRoute } from '../../utils/wizardSteps';
import StepStatus from './StepStatus';
import { api } from '../../services/api';

export default function WizardSidebar({ collapsed = false, onNavigate }) {
  const { tenderId, sections, currentStep, exportReady } = useWizardState();
  const navigate = useNavigate();

  if (!tenderId) return null;

  const handleStepClick = (step) => {
    navigate(stepRoute(step, tenderId));
    onNavigate && onNavigate();
  };

  const downloadDocx = () => {
    if (!exportReady) return;
    window.location.href = api.exportDocxUrl(tenderId);
  };

  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-sm overflow-hidden">
      <nav className="py-2">
        {sections.map((section, sIdx) => (
          <div key={section.id} className={clsx(sIdx > 0 && 'border-t border-gray-100 mt-1 pt-2')}>
            {!collapsed && (
              <div className="px-4 pb-1 flex items-center justify-between">
                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  {section.order}. {section.label}
                </span>
                <span className="text-[10px] text-gray-400">{section.finished} / {section.total}</span>
              </div>
            )}
            <ul>
              {section.items.map((step) => {
                const isCurrent = currentStep?.id === step.id;
                const isLocked = step.status === 'locked';
                const visualStatus = isCurrent && step.status !== 'finished' ? 'current' : step.status;
                const tooltip = isLocked ? step.gate.reason : (step.label);
                return (
                  <li key={step.id}>
                    <button
                      type="button"
                      onClick={() => handleStepClick(step)}
                      aria-disabled={isLocked || undefined}
                      title={tooltip}
                      className={clsx(
                        'w-full flex items-center gap-2 px-4 py-2 text-left text-sm transition',
                        collapsed && 'justify-center px-2',
                        isCurrent && 'bg-brand-50',
                        !isCurrent && 'hover:bg-gray-50',
                        isLocked && 'opacity-60'
                      )}
                    >
                      <StepStatus status={visualStatus} label={tooltip} />
                      {!collapsed && (
                        <>
                          <span
                            className={clsx(
                              'flex-1 truncate',
                              isCurrent ? 'font-semibold text-brand-800' : 'text-gray-700'
                            )}
                          >
                            {step.shortLabel || step.label}
                          </span>
                          {step.badge != null && (
                            <span
                              className={clsx(
                                'text-[10px] px-1.5 py-0.5 rounded-full font-medium flex-shrink-0',
                                step.section === 'analysis' || step.id === 'review'
                                  ? 'bg-amber-100 text-amber-800'
                                  : 'bg-gray-100 text-gray-600'
                              )}
                            >
                              {step.badge}
                            </span>
                          )}
                        </>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="border-t border-gray-100 p-2">
        <button
          type="button"
          onClick={downloadDocx}
          aria-disabled={!exportReady || undefined}
          title={exportReady ? 'Скачать ТЗ.docx с правками' : 'Завершите хотя бы одну стадию, чтобы скачать'}
          className={clsx(
            'w-full flex items-center justify-center gap-2 px-3 py-2 rounded text-sm font-medium transition',
            collapsed && 'px-2',
            exportReady
              ? 'bg-brand-600 text-white hover:bg-brand-700'
              : 'bg-gray-100 text-gray-400 cursor-not-allowed'
          )}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1v8.5l3-3 1 1L8 12 4 7.5l1-1 3 3V1zM2 14h12v1H2z"/></svg>
          {!collapsed && <span>Скачать ТЗ.docx</span>}
        </button>
      </div>
    </div>
  );
}
