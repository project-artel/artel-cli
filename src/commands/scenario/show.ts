import type { FetchLike } from '../../http/client.js';
import { getScenario } from '../../http/scenario.js';
import type { OutputSink } from '../../output/envelope.js';
import { resolveScenarioContext } from '../../scenario/context.js';
import { toScenarioPayload } from '../../scenario/report.js';
import { reportScenario } from './output.js';

export interface ScenarioShowCommandOptions {
  json: boolean;
  apiUrl?: string | undefined;
}

export async function runScenarioShow(
  scenarioId: string,
  options: ScenarioShowCommandOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: FetchLike,
): Promise<void> {
  const context = await resolveScenarioContext(env, options.apiUrl);
  const scenario = await getScenario(context.apiBaseUrl, context.cliToken, scenarioId, fetchImpl);
  reportScenario(sink, options.json, toScenarioPayload(scenario));
}
