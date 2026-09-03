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
 * 이 endpoint 는 아직 orchestration 서버에 없다. ARTEL-780 은 이것을 짓지 않으므로,
 * 서버가 404 로 답하면 일반적인 `server_error` 가 아니라 "서버가 아직 CLI 로그인을
 * 지원하지 않는다" 고 정확히 말한다.
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
      `The server at ${apiBaseUrl} does not support CLI login yet: it has no ${CLI_TOKEN_EXCHANGE_PATH} endpoint. Until that endpoint ships, authenticate by setting ARTEL_TOKEN to a token created in the console.`,
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
