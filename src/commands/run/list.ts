import type { FetchLike } from '../../http/client.js';
import { listTestRuns } from '../../http/testRuns.js';
import type { TestRunListPayload } from '../../output/contract.js';
import { writeJsonPayload, type OutputSink } from '../../output/envelope.js';
import { printTestRunList } from '../../output/human.js';
import { resolveTestRunContext } from '../../testRuns/context.js';
import { toTestRunPayload } from '../../testRuns/report.js';

export interface RunListCommandOptions {
  json: boolean;
  project: string;
  apiUrl?: string | undefined;
}

/** 프로젝트가 가진 test run 전부. `qa run --test-run` 에 무엇을 넘길지 고르기 전에 훑는 자리다. */
export async function runList(
  options: RunListCommandOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: FetchLike,
): Promise<void> {
  const context = await resolveTestRunContext(env, options.apiUrl);
  const runs = await listTestRuns(context.apiBaseUrl, context.cliToken, options.project, fetchImpl);

  const payload: TestRunListPayload = { items: runs.map(toTestRunPayload) };

  if (options.json) {
    writeJsonPayload(sink, payload);
    return;
  }
  printTestRunList(sink, payload);
}
