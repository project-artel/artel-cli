import type { FetchLike } from '../../http/client.js';
import { updateTestRun } from '../../http/testRuns.js';
import { writeJsonPayload, type OutputSink } from '../../output/envelope.js';
import { printTestRun } from '../../output/human.js';
import { resolveTestRunContext } from '../../testRuns/context.js';
import { toTestRunPayload } from '../../testRuns/report.js';

export interface RunUpdateCommandOptions {
  json: boolean;
  project: string;
  name?: string | undefined;
  description?: string | undefined;
  apiUrl?: string | undefined;
}

/** 이름·설명만 바꾼다. 시나리오 조합은 `run scenarios` 의 일이라 여기서 건드리지 않는다. */
export async function runUpdate(
  runId: string,
  options: RunUpdateCommandOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: FetchLike,
): Promise<void> {
  const context = await resolveTestRunContext(env, options.apiUrl);
  const run = await updateTestRun(
    context.apiBaseUrl,
    context.cliToken,
    options.project,
    runId,
    { name: options.name, description: options.description },
    fetchImpl,
  );

  const payload = toTestRunPayload(run);

  if (options.json) {
    writeJsonPayload(sink, payload);
    return;
  }
  printTestRun(sink, payload);
}
