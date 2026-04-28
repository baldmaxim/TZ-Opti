import { Link } from 'react-router-dom';
import { useWizardState } from '../../hooks/useWizardState';
import { stepRoute, findStep } from '../../utils/wizardSteps';

export default function GateNotice({ stepId }) {
  const { tenderId, steps } = useWizardState();
  const step = steps.find((s) => s.id === stepId) || findStep(stepId);
  if (!step || !tenderId) return null;

  const gate = step.gate || { open: true };
  if (gate.open) return null;

  const ctaStep = gate.cta?.stepId ? findStep(gate.cta.stepId) : null;

  return (
    <div className="card p-6 bg-amber-50 border-amber-200">
      <div className="flex items-start gap-3">
        <div className="text-2xl">🔒</div>
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-amber-900">
            Шаг закрыт: {step.label}
          </h3>
          <p className="text-sm text-amber-800 mt-1">{gate.reason}</p>
          {ctaStep && (
            <Link
              to={stepRoute(ctaStep, tenderId)}
              className="btn btn-primary mt-4"
            >
              {gate.cta.label} →
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
