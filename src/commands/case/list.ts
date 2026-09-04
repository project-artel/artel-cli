import { resolveCaseContext } from '../../case/context.js';
import { toTestCasePayload } from '../../case/report.js';
import type { FetchLike } from '../../http/client.js';
import { listTestCases } from '../../http/testcase.js';
import type { CaseListPayload } from '../../output/contract.js';
import type { OutputSink } from '../../output/envelope.js';
import { reportCaseList } from './output.js';

export interface CaseListCommandOptions {
  json: boolean;
  project: string;
  apiUrl?: string | undefined;
}

export async function runCaseList(
  options: CaseListCommandOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: FetchLike,
): Promise<void> {
  const context = await resolveCaseContext(env, options.apiUrl);
  const items = await listTestCases(
    context.apiBaseUrl,
    context.cliToken,
    options.project,
    fetchImpl,
  );

  const payload: CaseListPayload = { items: items.map(toTestCasePayload) };
  reportCaseList(sink, options.json, options.project, payload);
}
