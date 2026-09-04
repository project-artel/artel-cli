import { EXIT_FAILURE, EXIT_OK } from '../../exit.js';
import type { FetchLike } from '../../http/client.js';
import type { QaRunPayload } from '../../output/contract.js';
import { describeFollowEvent } from '../../output/human.js';
import type { OutputSink } from '../../output/envelope.js';
import { resolveQaContext, type QaContext } from '../../qa/context.js';
import { followQaRun, type QaFollowEvent } from '../../qa/follow.js';
import { buildQaRunPayload } from '../../qa/report.js';
import { reportQaRun } from './output.js';

export interface QaWatchCommandOptions {
  json: boolean;
  timeoutSeconds: number;
  apiUrl?: string | undefined;
  /** 테스트가 폴링과 재연결을 빠르게 돌리는 자리. 평소에는 기본값을 쓴다. */
  pollIntervalMs?: number | undefined;
  reconnectDelaysMs?: readonly number[] | undefined;
}

/** 이미 도는 런에 붙어 끝까지 본다. exit code 규칙은 `qa run` 과 같다. */
export async function runQaWatch(
  qaRunId: string,
  options: QaWatchCommandOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: FetchLike,
): Promise<number> {
  const context = await resolveQaContext(env, options.apiUrl);
  return await watchToEnd(context, qaRunId, options, sink, fetchImpl);
}

/**
 * 런이 끝날 때까지 지켜보고, 판정을 exit code 로 낸다.
 *
 * **통과했을 때만 0 이다.** 실패·취소는 물론 미상도 1 이다 — 소켓이 죽어 요약 없이 끝난
 * 런을 0 으로 두면 CI 에서 통과로 지나가고, 그것이 이 명령이 막아야 하는 사고다.
 */
export async function watchToEnd(
  context: QaContext,
  qaRunId: string,
  options: QaWatchCommandOptions,
  sink: OutputSink,
  fetchImpl?: FetchLike,
): Promise<number> {
  // 진행 상황은 stderr 로 간다. `--json` 이면 그 자리에 사건 한 줄씩 NDJSON 이 실리고,
  // stdout 에는 끝난 뒤의 payload 한 줄만 남는다 — 다른 명령들과 같은 규칙이다.
  const onEvent = (event: QaFollowEvent): void => {
    sink.err(options.json ? JSON.stringify(event) : describeFollowEvent(event));
  };

  const payload = await followToPayload(context, qaRunId, options, onEvent, fetchImpl);
  reportQaRun(sink, options.json, payload);
  return payload.verdict === 'PASSED' ? EXIT_OK : EXIT_FAILURE;
}

/**
 * 런 하나를 끝까지 따라가 payload 를 만든다. 아무것도 찍지 않는다.
 *
 * `watchToEnd` 에서 출력만 뺀 것이다. `qa matrix` 는 조합 여럿을 돌리고 stdout 에는 그
 * 전부를 담은 payload 한 줄만 내야 하므로, 조합마다 `reportQaRun` 을 부르는 `watchToEnd` 를
 * 그대로 쓸 수 없다. 진행 사건을 어디로 보낼지는 [onEvent] 를 준 쪽이 정한다.
 */
export async function followToPayload(
  context: QaContext,
  qaRunId: string,
  options: QaWatchCommandOptions,
  onEvent: (event: QaFollowEvent) => void,
  fetchImpl?: FetchLike,
): Promise<QaRunPayload> {
  const finished = await followQaRun({
    apiBaseUrl: context.apiBaseUrl,
    cliToken: context.cliToken,
    qaRunId,
    onEvent,
    fetchImpl,
    timeoutMs: options.timeoutSeconds * 1_000,
    pollIntervalMs: options.pollIntervalMs,
    reconnectDelaysMs: options.reconnectDelaysMs,
  });

  return await buildQaRunPayload(context.apiBaseUrl, context.cliToken, finished, fetchImpl);
}
