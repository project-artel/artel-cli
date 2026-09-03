import { CliError } from '../errors.js';

/**
 * HTTP 실패가 담는 전부. 요청 헤더는 담지 않는다 — `Authorization` 이 그대로 로그로
 * 흘러 나가는 경로를 만들지 않는다.
 */
export interface HttpFailure {
  status: number;
  code: string | null;
  message: string | null;
}

const MAX_SERVER_MESSAGE = 200;

export function parseHttpFailure(status: number, body: string): HttpFailure {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { status, code: null, message: null };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { status, code: null, message: null };
  }
  const fields = parsed as { code?: unknown; message?: unknown; error?: unknown };
  return {
    status,
    code: typeof fields.code === 'string' ? fields.code.slice(0, MAX_SERVER_MESSAGE) : null,
    message:
      typeof fields.message === 'string' ? fields.message.slice(0, MAX_SERVER_MESSAGE) : null,
  };
}

export function describeHttpFailure(failure: HttpFailure): string {
  const parts = [`HTTP ${String(failure.status)}`];
  if (failure.code !== null) {
    parts.push(failure.code);
  }
  if (failure.message !== null) {
    parts.push(failure.message);
  }
  return parts.join(' — ');
}

export function toCliError(endpoint: string, failure: HttpFailure): CliError {
  return new CliError('server_error', `${endpoint} answered ${describeHttpFailure(failure)}.`);
}
