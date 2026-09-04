import { CliError } from '../errors.js';
import type { FetchLike } from './client.js';
import { parseHttpFailure, toCliError, type HttpFailure } from './errors.js';

/**
 * `client.ts` 와 `gameInstances.ts` 는 각자 fetch 와 JSON 검증을 손으로 적었다. QA 는
 * endpoint 가 여섯 개라 그 방식이면 같은 코드가 여섯 벌이 된다. 이 모듈이 그 한 벌이다 —
 * 이미 있는 두 파일은 건드리지 않는다.
 */

const DEFAULT_TIMEOUT_MS = 15_000;

export interface JsonRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  endpoint: string;
  cliToken: string;
  /** 있으면 `application/json` 으로 직렬화해 보낸다. */
  body?: unknown;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  /**
   * 이 endpoint 만 아는 실패를 CLI 오류로 옮긴다. `null` 을 주면 일반 `server_error` 로
   * 떨어진다. 서버의 `code` 는 계약이고 `message` 는 우리가 고쳐 쓰는 산문이므로,
   * 분기는 언제나 `failure.code` 로 한다.
   */
  onFailure?: (failure: HttpFailure) => CliError | null;
}

/** 204 와 빈 body 는 `null` 이다. 그 밖에는 파싱된 JSON 값. */
export async function requestJson(request: JsonRequest): Promise<unknown> {
  const fetchImpl = request.fetchImpl ?? globalThis.fetch;
  const headers: Record<string, string> = {
    authorization: `Bearer ${request.cliToken}`,
    accept: 'application/json',
  };
  if (request.body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  let response: Response;
  try {
    response = await fetchImpl(request.endpoint, {
      method: request.method,
      headers,
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      signal: AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    throw new CliError(
      'network_error',
      `Could not reach ${request.endpoint}: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    text = '';
  }

  if (!response.ok) {
    const failure = parseHttpFailure(response.status, text);
    throw request.onFailure?.(failure) ?? toCliError(request.endpoint, failure);
  }

  if (response.status === 204 || text.trim().length === 0) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new CliError(
      'server_error',
      `${request.endpoint} answered with a body that is not valid JSON.`,
    );
  }
}

export function asObject(value: unknown, field: string, endpoint: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CliError(
      'server_error',
      `${endpoint} answered with "${field}" that is not a JSON object.`,
    );
  }
  return value as Record<string, unknown>;
}

export function asArray(value: unknown, field: string, endpoint: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new CliError('server_error', `${endpoint} answered without an array "${field}" field.`);
  }
  return value;
}

export function asString(value: unknown, field: string, endpoint: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CliError('server_error', `${endpoint} answered without a string "${field}" field.`);
  }
  return value;
}

export function asNullableString(value: unknown, field: string, endpoint: string): string | null {
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

export function asNumber(value: unknown, field: string, endpoint: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CliError('server_error', `${endpoint} answered without a number "${field}" field.`);
  }
  return value;
}

export function asNullableNumber(value: unknown, field: string, endpoint: string): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return asNumber(value, field, endpoint);
}

export function asBoolean(value: unknown, field: string, endpoint: string): boolean {
  if (typeof value !== 'boolean') {
    throw new CliError('server_error', `${endpoint} answered without a boolean "${field}" field.`);
  }
  return value;
}
