import { CliError } from '../errors.js';
import type { FetchLike } from '../http/client.js';
import {
  openContentMapEvents,
  readContentMapStreamFrame,
  startContentMapScan,
  type ContentMapIngestProgress,
  type ContentMapScanStatus,
} from '../http/contentMap.js';
import { watchSse } from '../http/sse.js';

/** 스캔이 더는 움직이지 않는 상태. */
const TERMINAL_SCAN_STATES = new Set(['SUCCEEDED', 'FAILED']);

export const DEFAULT_SCAN_RECONNECT_DELAYS_MS: readonly number[] = [
  500, 1_000, 2_000, 4_000, 8_000,
];

/** `doc scan` 이 보고하는 사건. */
export type ContentMapScanEvent =
  | { kind: 'requested'; gameInstanceId: string; gameInstanceName: string; requestedAt: string }
  | { kind: 'scan-state'; state: string; error: string | null }
  | { kind: 'ingest'; progress: ContentMapIngestProgress }
  | { kind: 'reconnect'; attempt: number; of: number; delayMs: number };

export interface ScanContentMapOptions {
  apiBaseUrl: string;
  cliToken: string;
  projectId: string;
  gameBuildId: string;
  watch: boolean;
  /** `0` 이면 상한 없음. `watch` 가 아니면 쓰이지 않는다. */
  timeoutMs: number;
  onEvent: (event: ContentMapScanEvent) => void;
  fetchImpl?: FetchLike | undefined;
  reconnectDelaysMs?: readonly number[] | undefined;
}

export interface ContentMapScanResult {
  status: ContentMapScanStatus;
  watched: boolean;
}

/**
 * 붙어 있는 게임에 `evidence` 스캔을 시키고, 부탁하면 그것이 끝나는 것까지 본다.
 *
 * **기본은 202 를 받고 끝내는 것이다.** 스캔은 씬을 걸어 다니는 일이라 즉시 끝나지 않고,
 * CI 에서 그것을 기다릴 이유가 늘 있는 것도 아니다. 기다릴 때는 polling 이 아니라 SSE 로
 * 붙는다 — 이 endpoint 가 진행을 push 로 준다.
 */
export async function scanContentMap(
  options: ScanContentMapOptions,
): Promise<ContentMapScanResult> {
  const requested = await startContentMapScan(
    options.apiBaseUrl,
    options.cliToken,
    options.projectId,
    options.gameBuildId,
    options.fetchImpl,
  );
  options.onEvent({
    kind: 'requested',
    gameInstanceId: requested.gameInstanceId,
    gameInstanceName: requested.gameInstanceName,
    requestedAt: requested.requestedAt,
  });

  if (!options.watch) {
    return { status: requested, watched: false };
  }

  return { status: await watchScan(options, requested), watched: true };
}

/**
 * `lastScan.state` 가 `SUCCEEDED` 나 `FAILED` 로 갈 때까지 본다.
 *
 * 구독 직후 오는 `snapshot` 이 이미 종단이면 거기서 끝난다 — 짧은 스캔은 202 를 받고 붙는
 * 사이에 이미 끝나 있을 수 있고, 그때 `scan` frame 은 다시 오지 않는다.
 */
export async function watchScan(
  options: ScanContentMapOptions,
  /**
   * 이 명령이 방금 시킨 스캔. `map show --watch` 처럼 남이 시킨 스캔을 따라갈 때는 `null` 이고,
   * 그때 timeout 메시지가 게임 이름을 대지 못한다 — 그 값은 시킨 쪽의 응답에만 있다.
   */
  requested: ContentMapScanStatus | null,
): Promise<ContentMapScanStatus> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const reconnectDelaysMs = options.reconnectDelaysMs ?? DEFAULT_SCAN_RECONNECT_DELAYS_MS;
  let lastState: string | null = null;

  return await watchSse<ContentMapScanStatus>({
    open: (signal) =>
      openContentMapEvents(
        options.apiBaseUrl,
        options.cliToken,
        options.projectId,
        options.gameBuildId,
        signal,
        fetchImpl,
      ),
    read: (sseFrame) => {
      const frame = readContentMapStreamFrame(sseFrame.data);
      if (frame === null) {
        return null;
      }
      if (frame.ingest !== null) {
        options.onEvent({ kind: 'ingest', progress: frame.ingest });
      }
      const scan = frame.scan;
      if (scan === null) {
        return null;
      }
      if (scan.state !== lastState) {
        lastState = scan.state;
        options.onEvent({ kind: 'scan-state', state: scan.state, error: scan.error });
      }
      return TERMINAL_SCAN_STATES.has(scan.state) ? scan : null;
    },
    timeoutMs: options.timeoutMs,
    reconnectDelaysMs,
    onReconnect: (attempt, of, delayMs) => {
      options.onEvent({ kind: 'reconnect', attempt, of, delayMs });
    },
    onTimeout: () =>
      new CliError(
        'content_map_watch_timeout',
        `Stopped watching the scan of game build ${options.gameBuildId} after ${String(Math.round(options.timeoutMs / 1_000))}s. ${requested === null ? 'The scan' : `Game instance ${requested.gameInstanceName}`} still has the command; raise --timeout, or stop watching and read the content map later.`,
      ),
    onDisconnected: (attempts) =>
      new CliError(
        'content_map_watch_disconnected',
        `Lost the content map event stream for game build ${options.gameBuildId} and could not reconnect after ${String(attempts)} attempts. The scan was requested either way; only the progress view was lost.`,
      ),
  });
}
