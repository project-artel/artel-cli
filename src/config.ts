import { CliError } from './errors.js';

/**
 * 콘솔(artel-home) 의 운영 주소. relay page `/sdk-login` 이 여기에 있다.
 * `AuthProperties` 의 allowed origins 에 있는 값이다.
 */
const DEFAULT_CONSOLE_BASE_URL = 'https://artel.kr';

export interface CliConfig {
  apiBaseUrl: string;
  consoleBaseUrl: string;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * orchestration API 의 운영 host 는 orchestration 저장소에도 artel-home 저장소에도
 * 문자열로 적혀 있지 않다(artel-home 은 `VITE_ORCHESTRATION_URL` 로 주입받는다).
 * 기본값을 지어내면 staging token 을 운영에 쏘는 사고가 조용히 일어나므로,
 * 기본값이 정해질 때까지 `ARTEL_API_BASE_URL` 을 필수로 둔다.
 */
export function resolveApiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.ARTEL_API_BASE_URL?.trim();
  if (!configured) {
    throw new CliError(
      'missing_api_base_url',
      'ARTEL_API_BASE_URL is not set. The orchestration API host has no default yet, so set it explicitly (for example ARTEL_API_BASE_URL=http://localhost:8080).',
    );
  }
  return normalizeBaseUrl(configured);
}

export function resolveConsoleBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.ARTEL_CONSOLE_BASE_URL?.trim();
  return normalizeBaseUrl(configured ?? DEFAULT_CONSOLE_BASE_URL);
}

export function resolveConfig(env: NodeJS.ProcessEnv = process.env): CliConfig {
  return {
    apiBaseUrl: resolveApiBaseUrl(env),
    consoleBaseUrl: resolveConsoleBaseUrl(env),
  };
}
