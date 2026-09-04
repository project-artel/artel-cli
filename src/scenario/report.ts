import type { Scenario, ScenarioSummary } from '../http/scenario.js';
import type {
  ScenarioPayload,
  ScenarioStepPayload,
  ScenarioSummaryPayload,
} from '../output/contract.js';

export function toScenarioPayload(scenario: Scenario): ScenarioPayload {
  return {
    scenarioId: scenario.scenarioId,
    projectId: scenario.projectId,
    title: scenario.draft.title,
    description: scenario.draft.description,
    steps: scenario.draft.steps.map((step, index): ScenarioStepPayload => ({
      step: index + 1,
      action: step.action,
      caseId: step.caseId,
      hint: step.hint,
      input: step.input,
      expectedPassed: step.expectedPassed,
    })),
  };
}

export function toScenarioSummaryPayload(summary: ScenarioSummary): ScenarioSummaryPayload {
  return {
    scenarioId: summary.scenarioId,
    projectId: summary.projectId,
    title: summary.title,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
  };
}
