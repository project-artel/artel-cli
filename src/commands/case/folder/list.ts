import { resolveCaseContext } from '../../../case/context.js';
import { toTestCaseFolderPayload } from '../../../case/report.js';
import type { FetchLike } from '../../../http/client.js';
import { listTestCaseFolders } from '../../../http/testcaseFolders.js';
import type { CaseFolderListPayload } from '../../../output/contract.js';
import type { OutputSink } from '../../../output/envelope.js';
import { reportCaseFolderList } from '../output.js';

export interface CaseFolderListCommandOptions {
  json: boolean;
  project: string;
  apiUrl?: string | undefined;
}

export async function runCaseFolderList(
  options: CaseFolderListCommandOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: FetchLike,
): Promise<void> {
  const context = await resolveCaseContext(env, options.apiUrl);
  const folders = await listTestCaseFolders(
    context.apiBaseUrl,
    context.cliToken,
    options.project,
    fetchImpl,
  );

  const payload: CaseFolderListPayload = { items: folders.map(toTestCaseFolderPayload) };
  reportCaseFolderList(sink, options.json, options.project, payload);
}
