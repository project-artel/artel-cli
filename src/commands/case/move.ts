import { resolveCaseContext } from '../../case/context.js';
import { readFolderTarget } from '../../case/folder-target.js';
import { UsageError } from '../../errors.js';
import type { FetchLike } from '../../http/client.js';
import { moveTestCases } from '../../http/testcaseFolders.js';
import type { CaseMovePayload } from '../../output/contract.js';
import type { OutputSink } from '../../output/envelope.js';
import { reportCaseMove } from './output.js';

/** 서버 `WIRE_ID_LIMIT`. 이보다 많으면 서버가 400 으로 막으므로 요청하기 전에 알린다. */
const MAX_CASES_PER_MOVE = 500;

export interface CaseMoveCommandOptions {
  json: boolean;
  project: string;
  folder?: string | undefined;
  root: boolean;
  apiUrl?: string | undefined;
}

export async function runCaseMove(
  caseIds: string[],
  options: CaseMoveCommandOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: FetchLike,
): Promise<void> {
  const target = readFolderTarget(options.folder, options.root, '--folder');
  if (target === undefined) {
    throw new UsageError('Pass --folder <id> to move into a folder, or --root for no folder.');
  }
  if (caseIds.length > MAX_CASES_PER_MOVE) {
    throw new UsageError(
      `case move takes at most ${String(MAX_CASES_PER_MOVE)} case ids at once; got ${String(caseIds.length)}.`,
    );
  }

  const context = await resolveCaseContext(env, options.apiUrl);
  const moved = await moveTestCases(
    context.apiBaseUrl,
    context.cliToken,
    options.project,
    caseIds,
    target,
    fetchImpl,
  );

  const payload: CaseMovePayload = {
    projectId: options.project,
    folderId: target,
    requested: new Set(caseIds).size,
    moved,
  };
  reportCaseMove(sink, options.json, payload);
}
