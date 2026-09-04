import { resolveDocContext } from '../../doc/context.js';
import { scanContentMap, type ContentMapScanEvent } from '../../doc/scan-flow.js';
import { EXIT_FAILURE, EXIT_OK } from '../../exit.js';
import type { FetchLike } from '../../http/client.js';
import type { ContentMapScanPayload } from '../../output/contract.js';
import { writeJsonPayload, type OutputSink } from '../../output/envelope.js';
import { describeContentMapScanEvent, printContentMapScan } from '../../output/human.js';

export interface DocScanCommandOptions {
  json: boolean;
  project: string;
  build: string;
  watch: boolean;
  timeoutSeconds: number;
  apiUrl?: string | undefined;
  /** 테스트가 재연결을 실제 시간으로 기다리지 않게 하는 자리. 평소에는 기본값을 쓴다. */
  reconnectDelaysMs?: readonly number[] | undefined;
}

/**
 * 붙어 있는 게임에 `evidence` 스캔을 시킨다.
 *
 * **`--watch` 없이는 stream 에 붙지 않는다.** 서버가 202 로 "명령이 나갔다"를 답하고 끝나는
 * 것이 이 명령의 기본 계약이고, 그 답을 받은 뒤에도 stream 을 여는 것은 CI 에서 끝나지 않는
 * job 을 만드는 일이다.
 */
export async function runDocScan(
  options: DocScanCommandOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: FetchLike,
): Promise<number> {
  const context = await resolveDocContext(env, options.apiUrl);

  const onEvent = (event: ContentMapScanEvent): void => {
    sink.err(options.json ? JSON.stringify(event) : describeContentMapScanEvent(event));
  };

  const result = await scanContentMap({
    apiBaseUrl: context.apiBaseUrl,
    cliToken: context.cliToken,
    projectId: options.project,
    gameBuildId: options.build,
    watch: options.watch,
    timeoutMs: options.timeoutSeconds * 1_000,
    onEvent,
    fetchImpl,
    reconnectDelaysMs: options.reconnectDelaysMs,
  });

  const payload: ContentMapScanPayload = {
    projectId: options.project,
    gameBuildId: options.build,
    gameInstanceId: result.status.gameInstanceId,
    gameInstanceName: result.status.gameInstanceName,
    state: result.status.state,
    requestedAt: result.status.requestedAt,
    finishedAt: result.status.finishedAt,
    ingestedDocuments: result.status.ingestedDocuments,
    error: result.status.error,
    watched: result.watched,
  };

  if (options.json) {
    writeJsonPayload(sink, payload);
  } else {
    printContentMapScan(sink, payload);
  }

  if (!result.watched) {
    return EXIT_OK;
  }
  return result.status.state === 'SUCCEEDED' ? EXIT_OK : EXIT_FAILURE;
}
