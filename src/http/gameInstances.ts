import { CliError } from '../errors.js';
import type { FetchLike } from './client.js';
import { parseHttpFailure, toCliError } from './errors.js';

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * `GameInstanceController`(orchestration)의 목록 경로. 이미 orchestration 저장소에 있는
 * endpoint 라 `SDK_TOKEN_MINT_PATH` 처럼 아직 정해지지 않은 값이 아니다.
 */
export function gameInstancesPath(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/game-instances`;
}

/** `GameInstanceResponse`(orchestration)와 같은 모양. */
export interface GameInstance {
  id: string;
  projectId: string;
  name: string;
  platform: string;
  connected: boolean;
  lastConnectedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * 어느 게임 build 가 방금 등록됐는지는 이 목록을 launch 전후로 두 번 불러 비교해서 찾는다
 * (`game/registration.ts`). end-user API 라서 `cli_token` 을 그대로 bearer 로 쓴다.
 */
export async function listGameInstances(
  apiBaseUrl: string,
  cliToken: string,
  projectId: string,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<GameInstance[]> {
  const endpoint = `${apiBaseUrl}${gameInstancesPath(projectId)}`;

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'GET',
      headers: { authorization: `Bearer ${cliToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new CliError(
      'network_error',
      `Could not reach ${endpoint}: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }

  const body = await readBodyText(response);
  if (!response.ok) {
    throw toCliError(endpoint, parseHttpFailure(response.status, body));
  }

  return parseGameInstanceList(body, endpoint);
}

async function readBodyText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function parseGameInstanceList(body: string, endpoint: string): GameInstance[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new CliError('server_error', `${endpoint} answered with a body that is not valid JSON.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CliError(
      'server_error',
      `${endpoint} answered with a body that is not a JSON object.`,
    );
  }

  const items: unknown = (parsed as { items?: unknown }).items;
  if (!Array.isArray(items)) {
    throw new CliError('server_error', `${endpoint} answered without an "items" array.`);
  }

  return items.map((item, index) => parseGameInstance(item, index, endpoint));
}

function parseGameInstance(value: unknown, index: number, endpoint: string): GameInstance {
  if (typeof value !== 'object' || value === null) {
    throw new CliError(
      'server_error',
      `${endpoint} answered with "items[${String(index)}]" that is not a JSON object.`,
    );
  }
  const fields = value as Partial<Record<keyof GameInstance, unknown>>;
  return {
    id: requireString(fields.id, `items[${String(index)}].id`, endpoint),
    projectId: requireString(fields.projectId, `items[${String(index)}].projectId`, endpoint),
    name: requireString(fields.name, `items[${String(index)}].name`, endpoint),
    platform: requireString(fields.platform, `items[${String(index)}].platform`, endpoint),
    connected: requireBoolean(fields.connected, `items[${String(index)}].connected`, endpoint),
    lastConnectedAt: requireNullableString(
      fields.lastConnectedAt,
      `items[${String(index)}].lastConnectedAt`,
      endpoint,
    ),
    createdAt: requireString(fields.createdAt, `items[${String(index)}].createdAt`, endpoint),
    updatedAt: requireString(fields.updatedAt, `items[${String(index)}].updatedAt`, endpoint),
  };
}

function requireString(value: unknown, field: string, endpoint: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CliError('server_error', `${endpoint} answered without a string "${field}" field.`);
  }
  return value;
}

function requireBoolean(value: unknown, field: string, endpoint: string): boolean {
  if (typeof value !== 'boolean') {
    throw new CliError('server_error', `${endpoint} answered without a boolean "${field}" field.`);
  }
  return value;
}

function requireNullableString(value: unknown, field: string, endpoint: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new CliError(
      'server_error',
      `${endpoint} answered with a "${field}" field that is neither a string nor null.`,
    );
  }
  return value;
}
