import type { FetchLike } from '../../http/client.js';
import { listScenarios } from '../../http/scenario.js';
import type { ScenarioListPayload } from '../../output/contract.js';
import { writeJsonPayload, type OutputSink } from '../../output/envelope.js';
import { printScenarioList } from '../../output/human.js';
import { resolveScenarioContext } from '../../scenario/context.js';
import { toScenarioSummaryPayload } from '../../scenario/report.js';

export interface ScenarioListCommandOptions {
  json: boolean;
  project: string;
  apiUrl?: string | undefined;
}

export async function runScenarioList(
  options: ScenarioListCommandOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: FetchLike,
): Promise<void> {
  const context = await resolveScenarioContext(env, options.apiUrl);
  const summaries = await listScenarios(
    context.apiBaseUrl,
    context.cliToken,
    options.project,
    fetchImpl,
  );

  const payload: ScenarioListPayload = {
    projectId: options.project,
    scenarios: summaries.map(toScenarioSummaryPayload),
  };

  if (options.json) {
    writeJsonPayload(sink, payload);
    return;
  }
  printScenarioList(sink, payload);
}
