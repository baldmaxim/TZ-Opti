'use strict';

// Реестр обработчиков очереди: task_type → функция, job_type → финализатор.
// Воркер ничего не знает про анализ ТЗ — только про этот реестр.

const stageAnalysisJob = require('./stageAnalysisJob');
const pipelineJob = require('./pipelineJob');

const taskHandlers = {
  stage_analysis: stageAnalysisJob.runTask,
  pipeline_begin: pipelineJob.runBegin,
  pipeline_step: pipelineJob.runStep,
  pipeline_finalize: pipelineJob.runFinalize,
};

// Вызывается, когда ЗАДАНИЕ пришло в терминальный статус (в т.ч. после
// восстановления очереди reaper'ом) — здесь чинятся производные состояния:
// статус стадии, статус pipeline-прогона.
const jobFinalizers = {
  stage_analysis: stageAnalysisJob.onJobSettled,
  pipeline: pipelineJob.onJobSettled,
};

module.exports = { taskHandlers, jobFinalizers };
