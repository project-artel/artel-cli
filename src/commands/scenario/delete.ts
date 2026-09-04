import type { FetchLike } from '../../http/client.js';
import { deleteScenario } from '../../http/scenario.js';
import type { ScenarioDeletePayload } from '../../output/contract.js';
import { writeJsonPayload, type OutputSink } from '../../output/envelope.js';
import { printScenarioDelete } from '../../output/human.js';
import { resolveScenarioContext } from '../../scenario/context.js';

export interface ScenarioDeleteCommandOptions {
  json: boolean;
  force: boolean;
  apiUrl?: string | undefined;
}

/**
 * QA 실행 이력이 있는 시나리오는 기본적으로 지워지지 않는다(서버 409, `scenario_has_qa_history`).
 * `--force` 는 그 이력까지 함께 지운다 — 되돌릴 수 없으므로 기본값이 아니다.
 */
export async function runScenarioDelete(
  scenarioId: string,
  options: ScenarioDeleteCommandOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: FetchLike,
): Promise<void> {
  const context = await resolveScenarioContext(env, options.apiUrl);
  await deleteScenario(context.apiBaseUrl, context.cliToken, scenarioId, options.force, fetchImpl);

  const payload: ScenarioDeletePayload = { scenarioId, deleted: true, forced: options.force };

  if (options.json) {
    writeJsonPayload(sink, payload);
    return;
  }
  printScenarioDelete(sink, payload);
}
