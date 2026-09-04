import type { RunScenarios, TestRun } from '../http/testRuns.js';
import type { TestRunPayload, TestRunScenariosPayload } from '../output/contract.js';

/** `TestRun` → `TestRunPayload`. `run list`·`run create`·`run show`·`run update` 가 모두 이 모양을 낸다. */
export function toTestRunPayload(run: TestRun): TestRunPayload {
  return {
    runId: run.id,
    projectId: run.projectId,
    name: run.name,
    description: run.description,
    createdAt: run.createdAt,
  };
}

/** `RunScenarios` → `TestRunScenariosPayload`. 조회와 `--set` 교체가 같은 모양을 낸다. */
export function toTestRunScenariosPayload(scenarios: RunScenarios): TestRunScenariosPayload {
  return {
    runId: scenarios.testRunId,
    items: scenarios.items.map((item) => ({
      position: item.position,
      testScenarioId: item.testScenarioId,
    })),
  };
}
