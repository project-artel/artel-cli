import { CliError } from '../errors.js';
import type { FetchLike } from './client.js';
import { openEventStream } from './documents.js';
import { asNumber, asObject, asString, requestJson } from './json.js';

/**
 * `ProjectContentMapController`(orchestration `contentmap/controller/ProjectContentMapController.kt`).
 *
 * 이 경로는 파일을 받지 않는다. `evidence` 문서는 게임이 스스로 만들어 `/api/sdk` 하위로
 * 올리고, `POST .../scan` 은 그 일을 **시작시키기만** 한다.
 */
export function contentMapPath(projectId: string, gameBuildId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/game-builds/${encodeURIComponent(gameBuildId)}/content-map`;
}

/**
 * `StartContentMapScanResponse` 와 `LastScanResponse` 를 한 모양으로 읽는다. 앞의 것은 202 의
 * body 라 [finishedAt] 아래 셋이 없고, 뒤의 것은 SSE 와 조회 API 가 싣는 값이라 다 있다.
 */
export interface ContentMapScanStatus {
  gameInstanceId: string;
  gameInstanceName: string;
  /** `REQUESTED` · `SUCCEEDED` · `FAILED`. */
  state: string;
  requestedAt: string;
  finishedAt: string | null;
  /** 이번 스캔이 앉힌 문서 수. `SUCCEEDED` 인데 0 이면 올라온 문서가 없었다. */
  ingestedDocuments: number | null;
  error: string | null;
}

/** `IngestProgressResponse`. 퍼센트가 아니라 세 수다 — 분모가 스캔 도중 계속 늘어난다. */
export interface ContentMapIngestProgress {
  receivedDocuments: number;
  ingestedDocuments: number;
  failedDocuments: number;
}

/**
 * `POST /api/projects/{projectId}/game-builds/{gameBuildId}/content-map/scan`.
 *
 * 상태코드 셋이 서로 다른 말을 하고, 그것을 뭉개면 안 된다.
 *
 * - **202** — 명령이 나갔다. 끝났다는 뜻이 아니다
 * - **409** — 빌드는 있는데 그것을 실행 중인 게임이 붙어 있지 않다. 게임을 켜면 된다
 * - **404** — 빌드가 없거나 경로의 `projectId` 가 그 빌드의 것과 다르다. id 를 고쳐야 한다
 *
 * 409 를 404 로 뭉개면 사용자는 "게임을 켜야 한다"와 "id 가 틀렸다"를 구분하지 못한 채
 * 같은 명령을 되풀이한다.
 */
export async function startContentMapScan(
  apiBaseUrl: string,
  cliToken: string,
  projectId: string,
  gameBuildId: string,
  fetchImpl?: FetchLike,
): Promise<ContentMapScanStatus> {
  const endpoint = `${apiBaseUrl}${contentMapPath(projectId, gameBuildId)}/scan`;
  const body = await requestJson({
    method: 'POST',
    endpoint,
    cliToken,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    onFailure: (failure) => {
      if (failure.status === 409) {
        return new CliError(
          'content_map_game_not_connected',
          `Game build ${gameBuildId} exists, but no running game is attached to it right now. A scan walks the scenes inside a live game, so start the build (for example with "artel game start") and run this again. The build id and the project id are both fine.`,
        );
      }
      if (failure.status === 404) {
        return new CliError(
          'content_map_build_not_found',
          `There is no game build ${gameBuildId} under project ${projectId}, or you cannot see it. This is not the same as "the game is not running": the id itself did not resolve, so check that --build belongs to --project.`,
        );
      }
      return null;
    },
  });

  return parseScanStatus(body, 'body', endpoint);
}

/**
 * `GET .../content-map/events`. **SSE 다.**
 *
 * 구독 직후 `snapshot` 이 한 번 오고, 그 뒤로 `scan` · `ingest` · `document` 가 온다.
 * 서버가 먼저 끊지 않는다 — 끝은 client 가 끊는 것뿐이다.
 *
 * 컨트롤러 KDoc 의 "cookie 인증이다" 는 브라우저 `EventSource` 가 header 를 싣지 못한다는
 * 설명이지 header 를 거절한다는 뜻이 아니다. `SecurityConfig` 의 bearer token converter 가
 * `Authorization` 을 먼저 보고 없을 때만 cookie 로 떨어지므로, CLI 의 Bearer token 이 통한다.
 */
export async function openContentMapEvents(
  apiBaseUrl: string,
  cliToken: string,
  projectId: string,
  gameBuildId: string,
  signal: AbortSignal,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<Response> {
  const endpoint = `${apiBaseUrl}${contentMapPath(projectId, gameBuildId)}/events`;
  return await openEventStream(endpoint, cliToken, signal, fetchImpl, (failure) =>
    failure.status === 404
      ? new CliError(
          'content_map_build_not_found',
          `There is no game build ${gameBuildId} under project ${projectId}, or you cannot see it.`,
        )
      : null,
  );
}

/** `ContentMapStreamEvent` 한 장. 안 실린 자리는 `null` 이다. */
export interface ContentMapStreamFrame {
  type: string;
  scan: ContentMapScanStatus | null;
  ingest: ContentMapIngestProgress | null;
}

/** frame 하나를 읽는다. JSON 이 아니거나 모양이 다르면 `null` — stream 을 그것 때문에 끊지 않는다. */
export function readContentMapStreamFrame(data: string): ContentMapStreamFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const frame = parsed as Record<string, unknown>;
  const type = frame['type'];
  if (typeof type !== 'string') {
    return null;
  }
  return {
    type,
    scan: readOptionalScanStatus(frame['scan']),
    ingest: readOptionalIngest(frame['ingest']),
  };
}

function readOptionalScanStatus(value: unknown): ContentMapScanStatus | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const state = record['state'];
  if (typeof state !== 'string') {
    return null;
  }
  return {
    gameInstanceId: readId(record['gameInstanceId']),
    gameInstanceName:
      typeof record['gameInstanceName'] === 'string' ? record['gameInstanceName'] : '',
    state,
    requestedAt: typeof record['requestedAt'] === 'string' ? record['requestedAt'] : '',
    finishedAt: typeof record['finishedAt'] === 'string' ? record['finishedAt'] : null,
    ingestedDocuments:
      typeof record['ingestedDocuments'] === 'number' ? record['ingestedDocuments'] : null,
    error: typeof record['error'] === 'string' ? record['error'] : null,
  };
}

function readOptionalIngest(value: unknown): ContentMapIngestProgress | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const received = record['receivedDocuments'];
  const ingested = record['ingestedDocuments'];
  const failed = record['failedDocuments'];
  if (typeof received !== 'number' || typeof ingested !== 'number' || typeof failed !== 'number') {
    return null;
  }
  return { receivedDocuments: received, ingestedDocuments: ingested, failedDocuments: failed };
}

/**
 * `gameInstanceId` 는 서버에서 JSON 숫자로 온다(`Long`). CLI 의 다른 id 필드와 모양을 맞추려고
 * 문자열로 접는다.
 */
function parseScanStatus(body: unknown, field: string, endpoint: string): ContentMapScanStatus {
  const record = asObject(body, field, endpoint);
  return {
    gameInstanceId: String(asNumber(record['gameInstanceId'], `${field}.gameInstanceId`, endpoint)),
    gameInstanceName: asString(record['gameInstanceName'], `${field}.gameInstanceName`, endpoint),
    state: asString(record['state'], `${field}.state`, endpoint),
    requestedAt: asString(record['requestedAt'], `${field}.requestedAt`, endpoint),
    finishedAt: typeof record['finishedAt'] === 'string' ? record['finishedAt'] : null,
    ingestedDocuments:
      typeof record['ingestedDocuments'] === 'number' ? record['ingestedDocuments'] : null,
    error: typeof record['error'] === 'string' ? record['error'] : null,
  };
}

function readId(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return typeof value === 'number' ? String(value) : '';
}
