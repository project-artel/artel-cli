import { resolveCaseContext } from '../../case/context.js';
import type { FetchLike } from '../../http/client.js';
import { deleteTestCase } from '../../http/testcase.js';
import type { CaseDeletePayload } from '../../output/contract.js';
import type { OutputSink } from '../../output/envelope.js';
import { reportCaseDeleted } from './output.js';

export interface CaseDeleteCommandOptions {
  json: boolean;
  project: string;
  apiUrl?: string | undefined;
}

export async function runCaseDelete(
  caseId: string,
  options: CaseDeleteCommandOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: FetchLike,
): Promise<void> {
  const context = await resolveCaseContext(env, options.apiUrl);
  await deleteTestCase(context.apiBaseUrl, context.cliToken, options.project, caseId, fetchImpl);

  const payload: CaseDeletePayload = { id: caseId, projectId: options.project, deleted: true };
  reportCaseDeleted(sink, options.json, payload);
}
