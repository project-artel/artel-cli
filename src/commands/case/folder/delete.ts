import { resolveCaseContext } from '../../../case/context.js';
import type { FetchLike } from '../../../http/client.js';
import { deleteTestCaseFolder } from '../../../http/testcaseFolders.js';
import type { CaseFolderDeletePayload } from '../../../output/contract.js';
import type { OutputSink } from '../../../output/envelope.js';
import { reportCaseFolderDeleted } from '../output.js';

export interface CaseFolderDeleteCommandOptions {
  json: boolean;
  project: string;
  apiUrl?: string | undefined;
}

export async function runCaseFolderDelete(
  folderId: string,
  options: CaseFolderDeleteCommandOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: FetchLike,
): Promise<void> {
  const context = await resolveCaseContext(env, options.apiUrl);
  await deleteTestCaseFolder(
    context.apiBaseUrl,
    context.cliToken,
    options.project,
    folderId,
    fetchImpl,
  );

  const payload: CaseFolderDeletePayload = {
    id: folderId,
    projectId: options.project,
    deleted: true,
  };
  reportCaseFolderDeleted(sink, options.json, payload);
}
