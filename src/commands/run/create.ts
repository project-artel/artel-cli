import type { FetchLike } from '../../http/client.js';
import { createTestRun } from '../../http/testRuns.js';
import { writeJsonPayload, type OutputSink } from '../../output/envelope.js';
import { printTestRun } from '../../output/human.js';
import { resolveTestRunContext } from '../../testRuns/context.js';
import { toTestRunPayload } from '../../testRuns/report.js';

export interface RunCreateCommandOptions {
  json: boolean;
  project: string;
  name: string;
  description?: string | undefined;
  apiUrl?: string | undefined;
}

/** 새 test run 을 만든다. 시나리오 조합은 비어 있는 채로 시작한다 — `run scenarios --set` 이 채운다. */
export async function runCreate(
  options: RunCreateCommandOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: FetchLike,
): Promise<void> {
  const context = await resolveTestRunContext(env, options.apiUrl);
  const run = await createTestRun(
    context.apiBaseUrl,
    context.cliToken,
    options.project,
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
