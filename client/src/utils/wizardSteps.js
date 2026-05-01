export const SECTIONS = [
  { id: 'setup', label: 'Подготовка', order: 1 },
  { id: 'analysis', label: 'Анализ ТЗ', order: 2 },
  { id: 'result', label: 'Результат', order: 3 },
];

export const STEPS = [
  { id: 'documents', section: 'setup', label: 'Документы', sub: 'documents', countKey: 'documents' },
  { id: 'checklist', section: 'setup', label: 'Состав работ', sub: 'checklist', countKey: 'checklist' },
  { id: 'conditions', section: 'setup', label: 'Условия компании', sub: 'conditions', countKey: 'conditions' },
  { id: 'risks', section: 'setup', label: 'База рисков', sub: 'risks', countKey: 'risks' },
  { id: 'qa', section: 'setup', label: 'Q&A форма', sub: 'qa' },
  { id: 'stage1', section: 'analysis', label: 'Стадия 1: ТЗ + Чек-лист + ВОР', shortLabel: 'Стадия 1', stage: 1 },
  { id: 'stage2', section: 'analysis', label: 'Стадия 2: Q&A → правки в ТЗ', shortLabel: 'Стадия 2', stage: 2 },
  { id: 'stage3', section: 'analysis', label: 'Стадия 3: Существенные условия', shortLabel: 'Стадия 3', stage: 3 },
  { id: 'stage4', section: 'analysis', label: 'Стадия 4: Типовые риски', shortLabel: 'Стадия 4', stage: 4 },
  { id: 'stage5', section: 'analysis', label: 'Стадия 5: Самоанализ ТЗ', shortLabel: 'Стадия 5', stage: 5 },
  { id: 'review', section: 'result', label: 'Рецензия', tail: 'review' },
  { id: 'export', section: 'result', label: 'Экспорт', tail: 'export' },
];

export function stepRoute(step, tenderId) {
  if (step.sub) return `/tenders/${tenderId}/setup/${step.sub}`;
  if (step.stage) return `/tenders/${tenderId}/stage/${step.stage}`;
  if (step.tail) return `/tenders/${tenderId}/${step.tail}`;
  return `/tenders/${tenderId}`;
}

export function findStep(id) {
  return STEPS.find((s) => s.id === id);
}

export function stepFromPath(pathname) {
  const m = pathname.match(/\/tenders\/[^/]+\/(setup\/([^/?#]+)|stage\/(\d+)|review|export)/);
  if (!m) return null;
  if (m[2]) return STEPS.find((s) => s.sub === m[2]) || null;
  if (m[3]) return STEPS.find((s) => s.stage === Number(m[3])) || null;
  if (m[1] === 'review') return STEPS.find((s) => s.tail === 'review') || null;
  if (m[1] === 'export') return STEPS.find((s) => s.tail === 'export') || null;
  return null;
}

function stageStatus(ctx, n) {
  return ctx.stages?.find((s) => s.stage === n)?.status;
}

export function gateForStep(step, ctx) {
  if (step.section === 'setup') return { open: true };

  if (step.id === 'stage1') {
    if (!ctx.hasTz) {
      return {
        open: false,
        reason: 'Загрузите ТЗ в разделе «Документы», чтобы запустить анализ.',
        cta: { label: 'Перейти к Документам', stepId: 'documents' },
      };
    }
    return { open: true };
  }
  if (step.id === 'stage2') {
    if (stageStatus(ctx, 1) !== 'finished') {
      return {
        open: false,
        reason: 'Сначала завершите Стадию 1.',
        cta: { label: 'Перейти к Стадии 1', stepId: 'stage1' },
      };
    }
    if (!ctx.hasQa) {
      return {
        open: false,
        reason: 'Загрузите Q&A форму (.xlsx) для запуска анализа характеристик.',
        cta: { label: 'Перейти к Q&A форме', stepId: 'qa' },
      };
    }
    return { open: true };
  }
  if (step.id === 'stage3') {
    if (stageStatus(ctx, 2) !== 'finished') {
      return {
        open: false,
        reason: 'Сначала завершите Стадию 2.',
        cta: { label: 'Перейти к Стадии 2', stepId: 'stage2' },
      };
    }
    return { open: true };
  }
  if (step.id === 'stage4') {
    if (stageStatus(ctx, 3) !== 'finished') {
      return {
        open: false,
        reason: 'Сначала завершите Стадию 3.',
        cta: { label: 'Перейти к Стадии 3', stepId: 'stage3' },
      };
    }
    return { open: true };
  }
  if (step.id === 'stage5') {
    if (stageStatus(ctx, 4) !== 'finished') {
      return {
        open: false,
        reason: 'Сначала завершите Стадию 4.',
        cta: { label: 'Перейти к Стадии 4', stepId: 'stage4' },
      };
    }
    return { open: true };
  }
  if (step.section === 'result') {
    const anyFinished = [1, 2, 3, 4, 5].some((n) => stageStatus(ctx, n) === 'finished');
    if (!anyFinished) {
      return {
        open: false,
        reason: 'Запустите и завершите хотя бы одну стадию анализа.',
        cta: { label: 'Перейти к Стадии 1', stepId: 'stage1' },
      };
    }
    return { open: true };
  }
  return { open: true };
}

export function statusForStep(step, ctx) {
  if (step.section === 'setup') {
    if (step.id === 'documents') return ctx.hasTz ? 'finished' : 'available';
    if (step.id === 'qa') return ctx.hasQa ? 'finished' : 'available';
    if (step.countKey) {
      const c = ctx.tender?.counts?.[step.countKey];
      return c && c > 0 ? 'finished' : 'available';
    }
    return 'available';
  }
  if (step.section === 'analysis') {
    const s = stageStatus(ctx, step.stage);
    if (s === 'finished') return 'finished';
    const gate = gateForStep(step, ctx);
    if (!gate.open) return 'locked';
    return 'available';
  }
  if (step.section === 'result') {
    const gate = gateForStep(step, ctx);
    if (!gate.open) return 'locked';
    return 'available';
  }
  return 'available';
}

export function badgeForStep(step, ctx) {
  if (step.section === 'setup' && step.countKey) {
    const c = ctx.tender?.counts?.[step.countKey];
    return c && c > 0 ? c : null;
  }
  if (step.section === 'analysis') {
    const summary = ctx.stages?.find((s) => s.stage === step.stage)?.summary?.summary;
    const cnt = summary?.issues_count;
    return cnt && cnt > 0 ? cnt : null;
  }
  if (step.id === 'review') {
    const p = ctx.tender?.counts?.issues_pending;
    return p && p > 0 ? p : null;
  }
  return null;
}

export function nextRecommendedStep(ctx) {
  for (const step of STEPS) {
    const status = statusForStep(step, ctx);
    if (status === 'available') return step;
  }
  return STEPS.find((s) => statusForStep(s, ctx) !== 'finished') || null;
}

export function nextStepAfter(currentStepId, ctx) {
  const idx = STEPS.findIndex((s) => s.id === currentStepId);
  if (idx < 0 || idx >= STEPS.length - 1) return null;
  for (let i = idx + 1; i < STEPS.length; i += 1) {
    return STEPS[i];
  }
  return null;
}
