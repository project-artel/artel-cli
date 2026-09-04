import { resolveCaseContext } from '../../case/context.js';
import { toTestCaseDetailPayload } from '../../case/report.js';
import type { FetchLike } from '../../http/client.js';
import { getTestCase } from '../../http/testcase.js';
import type { OutputSink } from '../../output/envelope.js';
import { reportTestCaseDetail } from './output.js';

export interface CaseShowCommandOptions {
  json: boolean;
  project: string;
  apiUrl?: string | undefined;
}

export async function runCaseShow(
  caseId: string,
  options: CaseShowCommandOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: FetchLike,
): Promise<void> {
  const context = await resolveCaseContext(env, options.apiUrl);
  const testCase = await getTestCase(
    context.apiBaseUrl,
    context.cliToken,
    options.project,
    caseId,
    fetchImpl,
  );
  reportTestCaseDetail(sink, options.json, toTestCaseDetailPayload(testCase));
}
