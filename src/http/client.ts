import { CliError } from '../errors.js';
import { parseHttpFailure, toCliError } from './errors.js';

export type FetchLike = typeof globalThis.fetch;

/** 재시도는 하지 않는다 — token 발급은 idempotent 하지 않다. */
const REQUEST_TIMEOUT_MS = 30_000;

export const CLI_TOKEN_EXCHANGE_PATH = '/api/auth/cli-tokens/exchange';

/** `POST /api/auth/cli-tokens` 와 같은 201 body. */
export interface CliTokenResponse {
  id: string;
  name: string;
  token: string;
  createdAt: string;
  expiresAt: string | null;
}

export interface CliTokenExchangeRequest {
  code: string;
  codeVerifier: string;
  name: string;
  /** `null` 은 만료 없음이다. */
  expiresInDays: number | null;
}

/**
 * 브라우저를 지나간 일회용 `code` 를, verifier 를 쥔 이쪽이 `artel_` token 으로 바꾼다.
 *
 * 이 endpoint 는 `CliTokenController.exchangeLoginCode` 로 서버에 있다. 그래도 404 를 따로
 * 다루는 이유는 배포마다 다르기 때문이다 — 이 CLI 는 자기가 가리키는 서버가 어느 버전인지
 * 모르고, 그것이 없는 배포를 가리켰을 때 일반 `server_error` 로 뭉개면 사용자는 자기 설정이
 * 틀린 줄 안다.
 */
export async function exchangeCliToken(
  apiBaseUrl: string,
  request: CliTokenExchangeRequest,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<CliTokenResponse> {
  const endpoint = `${apiBaseUrl}${CLI_TOKEN_EXCHANGE_PATH}`;

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new CliError(
      'network_error',
      `Could not reach ${endpoint}: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }

  if (response.status === 404) {
    throw new CliError(
      'login_not_supported',
      `The server at ${apiBaseUrl} has no ${CLI_TOKEN_EXCHANGE_PATH} endpoint, so it cannot complete a CLI login. That endpoint exists in the orchestration server; this deployment is probably older than it. Authenticate by setting ARTEL_TOKEN to a token created in the console.`,
    );
  }

  const body = await readBodyText(response);
  if (!response.ok) {
    throw toCliError(endpoint, parseHttpFailure(response.status, body));
  }

  return parseCliTokenResponse(body, endpoint);
}

async function readBodyText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function parseCliTokenResponse(body: string, endpoint: string): CliTokenResponse {
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

  const fields = parsed as Partial<Record<keyof CliTokenResponse, unknown>>;
  const id = requireString(fields.id, 'id', endpoint);
  const name = requireString(fields.name, 'name', endpoint);
  const token = requireString(fields.token, 'token', endpoint);
  const createdAt = requireString(fields.createdAt, 'createdAt', endpoint);
  const expiresAt = fields.expiresAt;
  if (expiresAt !== null && expiresAt !== undefined && typeof expiresAt !== 'string') {
    throw new CliError(
      'server_error',
      `${endpoint} answered with an "expiresAt" field that is neither a string nor null.`,
    );
  }

  return { id, name, token, createdAt, expiresAt: expiresAt ?? null };
}

/**
 * 값을 에러 메시지에 싣지 않는다. 빠진 필드가 `token` 일 수도 있고, 그 자리에 온 것을
 * 되비추면 평문 token 이 로그로 나간다.
 */
function requireString(value: unknown, field: string, endpoint: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CliError('server_error', `${endpoint} answered without a string "${field}" field.`);
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

/**
 * `SdkTokenController`(ARTEL-788)가 여는 자리. class 레벨 `@RequestMapping` 하나뿐이라
 * 경로에 동사가 붙지 않는다.
 *
 * `/api/auth/sdk/token` 과 헷갈리지 않게 하이픈으로 갈라져 있다. 그쪽은 permitAll 이고
 * 이쪽은 인증이 필요하다 — 두 경로를 헷갈리면 인증 규칙을 헷갈리는 것이다.
 */
export const SDK_TOKEN_MINT_PATH = '/api/auth/sdk-tokens';

/** `SdkTokenResponse`(`SdkAuthDtos.kt`)와 같은 모양이다. `game start`·`game logout` 이 매번 새로 낸다. */
export interface SdkTokenMintResponse {
  token: string;
  expiresAt: string | null;
  refreshToken: string;
  refreshExpiresAt: string | null;
  userId: string;
  displayName: string;
}

/**
 * `cli_token` 하나로, SDK 가 쓰는 `aud=artel-sdk` token 을 새로 낸다. 사용자는 CLI 자격
 * 증명만 쥐고 있고 SDK token 이 존재한다는 것조차 몰라도 된다 — 이 함수가 그 경계다.
 *
 * 이 endpoint 는 `SdkTokenController` 로 서버에 있다. 404 를 따로 다루는 것은
 * `exchangeCliToken` 과 같은 이유다 — 그것이 없는 배포를 가리켰을 때 일반 `server_error` 로
 * 뭉개면 사용자는 자기 project id 나 build 경로가 틀린 줄 안다.
 */
export async function mintSdkToken(
  apiBaseUrl: string,
  cliToken: string,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<SdkTokenMintResponse> {
  const endpoint = `${apiBaseUrl}${SDK_TOKEN_MINT_PATH}`;

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${cliToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new CliError(
      'network_error',
      `Could not reach ${endpoint}: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }

  if (response.status === 404) {
    throw new CliError(
      'sdk_token_not_supported',
      `The server at ${apiBaseUrl} has no ${SDK_TOKEN_MINT_PATH} endpoint, so it cannot mint an SDK token. That endpoint exists in the orchestration server; this deployment is probably older than it. "artel game start" and "artel game logout" cannot launch a signed-in build against it.`,
    );
  }

  const body = await readBodyText(response);
  if (!response.ok) {
    throw toCliError(endpoint, parseHttpFailure(response.status, body));
  }

  return parseSdkTokenMintResponse(body, endpoint);
}

function parseSdkTokenMintResponse(body: string, endpoint: string): SdkTokenMintResponse {
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

  const fields = parsed as Partial<Record<keyof SdkTokenMintResponse, unknown>>;
  return {
    token: requireString(fields.token, 'token', endpoint),
    refreshToken: requireString(fields.refreshToken, 'refreshToken', endpoint),
    userId: requireString(fields.userId, 'userId', endpoint),
    displayName: requireString(fields.displayName, 'displayName', endpoint),
    expiresAt: requireNullableString(fields.expiresAt, 'expiresAt', endpoint),
    refreshExpiresAt: requireNullableString(fields.refreshExpiresAt, 'refreshExpiresAt', endpoint),
  };
}
