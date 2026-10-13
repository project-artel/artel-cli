import { resolveCaseContext } from '../../../case/context.js';
import { toTestCaseFolderPayload } from '../../../case/report.js';
import type { FetchLike } from '../../../http/client.js';
import { createTestCaseFolder } from '../../../http/testcaseFolders.js';
import type { OutputSink } from '../../../output/envelope.js';
import { reportTestCaseFolder } from '../output.js';

export interface CaseFolderCreateCommandOptions {
  json: boolean;
  project: string;
  name: string;
  /** `--parent`. 없으면 최상위에 만든다. */
  parent?: string | undefined;
  apiUrl?: string | undefined;
}

export async function runCaseFolderCreate(
  options: CaseFolderCreateCommandOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: FetchLike,
): Promise<void> {
  const context = await resolveCaseContext(env, options.apiUrl);
  const created = await createTestCaseFolder(
    context.apiBaseUrl,
    context.cliToken,
    options.project,
    { name: options.name, parentId: options.parent ?? null },
    fetchImpl,
  );
  reportTestCaseFolder(
    sink,
    options.json,
    options.project,
    toTestCaseFolderPayload(created),
    'Created',
  );
}
