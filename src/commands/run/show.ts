import type { FetchLike } from '../../http/client.js';
import { getTestRun } from '../../http/testRuns.js';
import { writeJsonPayload, type OutputSink } from '../../output/envelope.js';
import { printTestRun } from '../../output/human.js';
import { resolveTestRunContext } from '../../testRuns/context.js';
import { toTestRunPayload } from '../../testRuns/report.js';

export interface RunShowCommandOptions {
  json: boolean;
  project: string;
  apiUrl?: string | undefined;
}

export async function runShow(
  runId: string,
  options: RunShowCommandOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: FetchLike,
): Promise<void> {
  const context = await resolveTestRunContext(env, options.apiUrl);
  const run = await getTestRun(
    context.apiBaseUrl,
    context.cliToken,
    options.project,
    runId,
    fetchImpl,
  );

  const payload = toTestRunPayload(run);

  if (options.json) {
    writeJsonPayload(sink, payload);
    return;
  }
  printTestRun(sink, payload);
}
