import { resolveCaseContext } from '../../case/context.js';
import { readFolderTarget } from '../../case/folder-target.js';
import { toTestCasePayload } from '../../case/report.js';
import type { FetchLike } from '../../http/client.js';
import { listTestCases } from '../../http/testcase.js';
import type { CaseListPayload } from '../../output/contract.js';
import type { OutputSink } from '../../output/envelope.js';
import { reportCaseList } from './output.js';

export interface CaseListCommandOptions {
  json: boolean;
  project: string;
  /** `--folder`. 이 folder 에 바로 든 케이스만 낸다. 하위 folder 의 케이스는 넣지 않는다. */
  folder?: string | undefined;
  /** `--root`. folder 가 없는 케이스만 낸다. */
  root?: boolean | undefined;
  apiUrl?: string | undefined;
}

export async function runCaseList(
  options: CaseListCommandOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: FetchLike,
): Promise<void> {
  const folder = readFolderTarget(options.folder, options.root ?? false, '--folder');
  const context = await resolveCaseContext(env, options.apiUrl);
  const items = await listTestCases(
    context.apiBaseUrl,
    context.cliToken,
    options.project,
    fetchImpl,
  );

  // 서버 목록 API 에는 필터가 없다(`TestCaseController.listTestCases`). 전량을 받아 여기서 거른다.
  const selected = folder === undefined ? items : items.filter((item) => item.folderId === folder);
  const payload: CaseListPayload = { items: selected.map(toTestCasePayload) };
  reportCaseList(sink, options.json, options.project, payload);
}
