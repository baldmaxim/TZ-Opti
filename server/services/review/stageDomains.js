'use strict';

// Реестр зон ответственности агентов-стадий: «тип результата на агента».
// Единый источник истины «какая стадия какие problem_type/risk_category вправе
// выдавать». Каждый агент пишет ТОЛЬКО в свой домен (Stage 2 не пишет риски как
// Stage 4, Stage 4 не переписывает решения Q&A и т.п.) — иначе конфликт выводов.
// Используется: гард в движке (backstop), слой сборки (consolidation), ярлыки UI.

const STAGE_DOMAINS = {
  1: {
    // учтено_частично — позиция ВОР тему покрывает, но не все операции
    // требования входят в её состав (структурное сопоставление, requirement_matches).
    resultType: 'Покрытие расчёта (объём / ВОР)',
    problemTypes: ['не_учтено_в_кп', 'не_учтено_в_вор', 'не_в_обоих', 'статус_не_определён', 'учтено_частично'],
    riskCategories: ['покрытие_расчёта'],
  },
  2: {
    resultType: 'Решения Q&A + характеристики',
    problemTypes: [
      'qa_противоречит_тз',
      'qa_исключено_из_кп',
      'qa_отсутствует_информация',
      'qa_отложенный_ответ',
      'qa_подтверждено',
      'qa_влияет_на_контур',
      'char_противоречит_тз',
      'char_не_отражена',
    ],
    riskCategories: ['договорной', 'объём_работ', 'данные', 'фиксация', 'характеристики'],
  },
  3: {
    resultType: 'Существенные условия компании',
    // условие_отсутствует — безъякорная находка покрытия (темы нет ни в одной
    // части ТЗ); условие_неоднозначно — тема затронута, но двусмысленна.
    problemTypes: ['условие_противоречит', 'условие_отсутствует', 'условие_неоднозначно'],
    riskCategories: ['существенные_условия'],
  },
  4: {
    // Категория риска приходит из библиотеки (risk.category) и не фиксирована —
    // домен Стадии 4 определяется типом problem_type='типовой_риск'.
    resultType: 'Типовые риски',
    problemTypes: ['типовой_риск'],
    riskCategories: null, // null = любая (из библиотеки рисков)
  },
  5: {
    // Стадия 5 = два механизма: challenger (независимый поиск пропущенного
    // основными стадиями — цитатные issues этих типов) и QC самоанализа
    // (заметки о качестве кластеров, issues не порождает).
    resultType: 'Самоанализ ТЗ',
    problemTypes: ['пропущенный_риск', 'скрытые_работы', 'двусмысленная_формулировка', 'влияние_на_срок'],
    riskCategories: ['объём_и_обязательства', 'юридические_формулировки', 'график'],
  },
};

// problem_type → номер стадии-владельца (или null, если тип неизвестен).
const OWNER_BY_TYPE = (() => {
  const map = new Map();
  for (const [stage, dom] of Object.entries(STAGE_DOMAINS)) {
    for (const t of dom.problemTypes) map.set(t, Number(stage));
  }
  return map;
})();

function ownerStageOf(problemType) {
  return OWNER_BY_TYPE.get(problemType) || null;
}

function isOwnedBy(stage, problemType) {
  const dom = STAGE_DOMAINS[stage];
  return !!dom && dom.problemTypes.includes(problemType);
}

function stageResultType(stage) {
  return STAGE_DOMAINS[stage] ? STAGE_DOMAINS[stage].resultType : `Стадия ${stage}`;
}

module.exports = { STAGE_DOMAINS, ownerStageOf, isOwnedBy, stageResultType };
