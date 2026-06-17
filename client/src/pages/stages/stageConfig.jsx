import { STAGE_META, stageLabel, stageShort } from '../../utils/labels';

// STAGE_CONFIG собирается из единого источника STAGE_META (client/src/utils/labels.js).
// Не хардкодить названия здесь — править тексты в STAGE_META.
export const STAGE_CONFIG = Object.fromEntries(
  Object.keys(STAGE_META).map((n) => [
    n,
    {
      label: stageLabel(Number(n)),
      short: stageShort(Number(n)),
      description: STAGE_META[n].description,
    },
  ]),
);
