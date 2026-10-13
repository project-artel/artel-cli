import { resolveCaseContext } from '../../../case/context.js';
import { readFolderTarget } from '../../../case/folder-target.js';
import { toTestCaseFolderPayload } from '../../../case/report.js';
import { CliError, UsageError } from '../../../errors.js';
import type { FetchLike } from '../../../http/client.js';
import { listTestCaseFolders, updateTestCaseFolder } from '../../../http/testcaseFolders.js';
import type { OutputSink } from '../../../output/envelope.js';
import { reportTestCaseFolder } from '../output.js';

export interface CaseFolderUpdateCommandOptions {
  json: boolean;
  project: string;
  name?: string | undefined;
  /** `--parent`. 이 folder 아래로 옮긴다. */
  parent?: string | undefined;
  /** `--root`. 최상위로 옮긴다. */
  root: boolean;
  apiUrl?: string | undefined;
}

/**
 * 이름이나 부모 folder 를 바꾼다.
 *
 * 서버의 `PUT` 은 `name` 과 `parentId` 를 모두 받고, `parentId` 가 비어 있으면 최상위로 옮긴다.
 * 이름만 바꾸려고 `parentId` 를 빼고 보내면 folder 가 최상위로 옮겨진다. 그래서 먼저 목록에서
 * 현재 값을 읽고, 사용자가 주지 않은 칸은 그 값으로 채워 보낸다. 단건 조회 endpoint 가 없어
 * 목록을 읽는다.
 */
export async function runCaseFolderUpdate(
  folderId: string,
  options: CaseFolderUpdateCommandOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: FetchLike,
): Promise<void> {
  const parent = readFolderTarget(options.parent, options.root, '--parent');
  if (options.name === undefined && parent === undefined) {
    throw new UsageError('Nothing to update: pass --name, --parent, or --root.');
  }

  const context = await resolveCaseContext(env, options.apiUrl);
  const folders = await listTestCaseFolders(
    context.apiBaseUrl,
    context.cliToken,
    options.project,
    fetchImpl,
  );
  const current = folders.find((folder) => folder.id === folderId);
  if (current === undefined) {
    throw new CliError(
      'case_folder_not_found',
      `There is no folder ${folderId} in project ${options.project}.`,
    );
  }

  const updated = await updateTestCaseFolder(
    context.apiBaseUrl,
    context.cliToken,
    options.project,
    folderId,
    {
      name: options.name ?? current.name,
      parentId: parent === undefined ? current.parentId : parent,
    },
    fetchImpl,
  );
  reportTestCaseFolder(
    sink,
    options.json,
    options.project,
    toTestCaseFolderPayload(updated),
    'Updated',
  );
}
