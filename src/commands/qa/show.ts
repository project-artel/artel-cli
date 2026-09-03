import type { FetchLike } from '../../http/client.js';
import { getQaRun } from '../../http/qa.js';
import type { OutputSink } from '../../output/envelope.js';
import { resolveQaContext } from '../../qa/context.js';
import { buildQaRunPayload } from '../../qa/report.js';
import { reportQaRun } from './output.js';

export interface QaShowCommandOptions {
  json: boolean;
  apiUrl?: string | undefined;
}

/**
 * 런 하나의 판정과 이슈.
 *
 * 판정이 무엇이든 exit code 는 0 이다 — 조회에 성공한 것과 테스트가 통과한 것은 다른
 * 질문이고, 판정으로 CI 를 가르는 것은 `qa run`/`qa watch` 의 일이다.
 */
export async function runQaShow(
  qaRunId: string,
  options: QaShowCommandOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: FetchLike,
): Promise<void> {
  const context = await resolveQaContext(env, options.apiUrl);
  const run = await getQaRun(context.apiBaseUrl, context.cliToken, qaRunId, fetchImpl);
  const payload = await buildQaRunPayload(context.apiBaseUrl, context.cliToken, run, fetchImpl);
  reportQaRun(sink, options.json, payload);
}
