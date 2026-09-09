import { DEFAULT_SCAN_RECONNECT_DELAYS_MS, watchScan } from '../../doc/scan-flow.js';
import type { FetchLike } from '../../http/client.js';
import { readContentMap, type ContentMapView } from '../../http/contentMap.js';
import { resolveDocContext } from '../../doc/context.js';
import type { ContentMapViewPayload } from '../../output/contract.js';
import { writeJsonPayload, type OutputSink } from '../../output/envelope.js';
import { describeContentMapScanEvent } from '../../output/human.js';

export interface MapShowCommandOptions {
  json: boolean;
  project: string;
  build: string;
  /** 남이 시킨 스캔이라도 끝날 때까지 따라간다. */
  watch: boolean;
  /** `0` 이면 상한 없음. `watch` 가 아니면 쓰이지 않는다. */
  timeoutSeconds: number;
  apiUrl?: string | undefined;
}

/**
 * 이 빌드의 content map 이 무엇을 담고 있는지 본다.
 *
 * `--content-map-mode` 를 축으로 재는 실험에서, 그 arm 이 더 나빴을 때 map 이 비어 있었던
 * 것인지 내용이 틀렸던 것인지를 가르는 자리다.
 *
 * 스캔을 걸지는 않는다. 그것은 `artel doc scan` 의 일이고, 이 명령은 이미 있는 것을 읽는다 —
 * `--watch` 는 남이 시킨 스캔을 따라가는 것이지 새로 시키는 것이 아니다.
 */
export async function runMapShow(
  options: MapShowCommandOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: FetchLike,
  reconnectDelaysMs: readonly number[] = DEFAULT_SCAN_RECONNECT_DELAYS_MS,
): Promise<void> {
  const context = await resolveDocContext(env, options.apiUrl);

  if (options.watch) {
    // 진행은 stderr 로 간다. `--json` 을 켠 쪽의 stdout 에는 payload 한 줄만 남아야 한다.
    await watchScan(
      {
        apiBaseUrl: context.apiBaseUrl,
        cliToken: context.cliToken,
        projectId: options.project,
        gameBuildId: options.build,
        watch: true,
        timeoutMs: options.timeoutSeconds * 1_000,
        onEvent: (event) => {
          sink.err(describeContentMapScanEvent(event));
        },
        ...(fetchImpl === undefined ? {} : { fetchImpl }),
        reconnectDelaysMs,
      },
      null,
    );
  }

  // 지도는 언제나 stream 이 아니라 조회로 읽는다. `--watch` 로 본 마지막 frame 을 그대로
  // 쓰면, 붙기 전에 끝난 스캔과 붙어서 본 스캔이 서로 다른 값을 말하게 된다.
  const view = await readContentMap(
    context.apiBaseUrl,
    context.cliToken,
    options.project,
    options.build,
    fetchImpl,
  );

  const payload: ContentMapViewPayload = {
    projectId: options.project,
    gameBuildId: options.build,
    contentMapId: view.contentMap?.id ?? null,
    ingestedAt: view.contentMap?.ingestedAt ?? null,
    scenes: view.sceneCount,
    edges: view.edgeCount,
    screenTransitions: view.screenTransitionCount,
    gaps: view.gapCount,
    pendingDocuments: view.pendingDocumentCount,
    verifiedFeatures: view.verifiedFeatures,
    totalFeatures: view.totalFeatures,
    lastScanState: view.lastScan?.state ?? null,
    lastScanFinishedAt: view.lastScan?.finishedAt ?? null,
    lastScanError: view.lastScan?.error ?? null,
  };

  if (options.json) {
    writeJsonPayload(sink, payload);
    return;
  }
  printContentMap(sink, view, payload);
}

function printContentMap(
  sink: OutputSink,
  view: ContentMapView,
  payload: ContentMapViewPayload,
): void {
  // 두 "없음" 을 갈라 적는다. 다음에 할 일이 다르다 — 하나는 문서를 올리는 것이고 다른 하나는
  // 앉기를 기다리거나 왜 못 앉았는지 보는 것이다.
  if (view.contentMap === null) {
    sink.out(
      `Game build ${payload.gameBuildId} has no content map yet: no evidence document has been registered. Run "artel doc scan" with the game running.`,
    );
    printScan(sink, payload);
    return;
  }
  if (view.contentMap.ingestedAt === null) {
    sink.out(
      `Content map ${view.contentMap.id} exists but nothing has been ingested into it yet.`,
    );
  } else {
    sink.out(`Content map ${view.contentMap.id}, last ingested ${view.contentMap.ingestedAt}.`);
  }

  sink.out(`  scenes             ${String(payload.scenes)}`);
  sink.out(`  scene edges        ${String(payload.edges)}`);
  sink.out(`  screen transitions ${String(payload.screenTransitions)}`);
  sink.out(`  spec gaps          ${String(payload.gaps)}`);
  sink.out(`  pending documents  ${String(payload.pendingDocuments)}`);
  sink.out(
    `  verified features  ${String(payload.verifiedFeatures)}/${String(payload.totalFeatures)}`,
  );
  printScan(sink, payload);
}

function printScan(sink: OutputSink, payload: ContentMapViewPayload): void {
  if (payload.lastScanState === null) {
    // 서버가 뜬 뒤로 시킨 적이 없다는 뜻이지, 지도가 스캔 없이 생겼다는 뜻이 아니다.
    sink.out('  last scan          none since the server started');
    return;
  }
  sink.out(
    `  last scan          ${payload.lastScanState}${
      payload.lastScanFinishedAt === null ? '' : ` at ${payload.lastScanFinishedAt}`
    }${payload.lastScanError === null ? '' : ` — ${payload.lastScanError}`}`,
  );
}
