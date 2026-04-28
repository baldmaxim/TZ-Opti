import { Link } from 'react-router-dom';
import { useWizardState } from '../../hooks/useWizardState';
import { stepRoute } from '../../utils/wizardSteps';

export default function NextStepCta({ hint, override, disabled = false, disabledHint }) {
  const { tenderId, nextStep } = useWizardState();
  const target = override || nextStep;
  if (!tenderId || !target) return null;

  const route = stepRoute(target, tenderId);
  const label = target.shortLabel || target.label;

  return (
    <div className="mt-6 flex items-center justify-between gap-3 flex-wrap border-t border-gray-100 pt-4">
      <div className="text-sm text-gray-500">
        {disabled ? (disabledHint || 'Завершите текущий шаг, чтобы продолжить.') : (hint || 'Когда будете готовы — переходите к следующему шагу.')}
      </div>
      {disabled ? (
        <span className="btn btn-secondary opacity-60 cursor-not-allowed" aria-disabled="true">Далее: {label} →</span>
      ) : (
        <Link to={route} className="btn btn-primary">Далее: {label} →</Link>
      )}
    </div>
  );
}
