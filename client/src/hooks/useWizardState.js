import { useLocation } from 'react-router-dom';
import { useTenderStore } from '../store/useTenderStore';
import {
  STEPS,
  SECTIONS,
  gateForStep,
  statusForStep,
  badgeForStep,
  stepFromPath,
  nextRecommendedStep,
  nextStepAfter,
  findStep,
} from '../utils/wizardSteps';

export function useWizardState() {
  const tender = useTenderStore((s) => s.tender);
  const stages = useTenderStore((s) => s.stages);
  const hasTz = useTenderStore((s) => s.hasTz);
  const hasQa = useTenderStore((s) => s.hasQa);
  const location = useLocation();

  const ctx = { tender, stages, hasTz, hasQa };
  const tenderId = tender?.id || null;

  const steps = STEPS.map((step) => ({
    ...step,
    status: statusForStep(step, ctx),
    gate: gateForStep(step, ctx),
    badge: badgeForStep(step, ctx),
  }));

  const currentStep = stepFromPath(location.pathname);
  const recommended = nextRecommendedStep(ctx);
  const nextAfterCurrent = currentStep ? nextStepAfter(currentStep.id, ctx) : null;
  const next = nextAfterCurrent || recommended;

  const sections = SECTIONS.map((sec) => {
    const items = steps.filter((st) => st.section === sec.id);
    const finished = items.filter((s) => s.status === 'finished').length;
    return { ...sec, items, finished, total: items.length };
  });

  const exportReady = stages?.some((s) => s.status === 'finished') || false;

  return {
    tenderId,
    steps,
    sections,
    currentStep,
    recommendedStep: recommended,
    nextStep: next,
    exportReady,
    findStep,
    ctx,
  };
}
