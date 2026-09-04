import { parseCaseBody, readCaseBody } from '../../case/body.js';
import { resolveCaseContext } from '../../case/context.js';
import { toTestCasePayload } from '../../case/report.js';
import { toUpdateRequest } from '../../case/requests.js';
import type { FetchLike } from '../../http/client.js';
import { updateTestCase } from '../../http/testcase.js';
import type { OutputSink } from '../../output/envelope.js';
import { reportTestCase } from './output.js';

export interface CaseUpdateCommandOptions {
  json: boolean;
  project: string;
  /** `--file`. 없으면 표준입력을 읽는다. */
  file?: string | undefined;
  apiUrl?: string | undefined;
}

/** 준 필드만 바뀐다 — 서버 쪽 규칙([TestCaseUpdateRequest]) 그대로다. */
export async function runCaseUpdate(
  caseId: string,
  options: CaseUpdateCommandOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: FetchLike,
  stdin?: NodeJS.ReadableStream,
): Promise<void> {
  const context = await resolveCaseContext(env, options.apiUrl);
  const text = await readCaseBody(options.file, stdin);
  const request = toUpdateRequest(parseCaseBody(text, options.file));

  const updated = await updateTestCase(
    context.apiBaseUrl,
    context.cliToken,
    options.project,
    caseId,
    request,
    fetchImpl,
  );
  reportTestCase(sink, options.json, toTestCasePayload(updated), 'Updated');
}
