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

/** `http://localhost:8080` 처럼 이 기계를 가리키는 주소인가. */
function isLoopback(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return false;
  }
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

/**
 * console 주소는 API 주소와 반드시 짝이 맞아야 한다.
 *
 * 로그인은 console 이 코드를 발급하고 API 가 그것을 소비하는 왕복이다. 둘이 다른 배포를
 * 가리키면 코드가 한쪽 Redis 에만 있어 교환이 **반드시** 실패한다. 게임에 넘길 때도 같다 —
 * `-artel-frontend` 가 운영을 가리키는 채로 로컬 API 에 붙은 빌드는, 오버레이가 로그인을
 * 물어야 하는 순간에 사람을 엉뚱한 곳으로 보낸다.
 *
 * 그래서 API 가 이 기계를 가리키는데 console 을 말해 주지 않은 경우는 기본값으로 때우지 않고
 * 거절한다. 운영 API 를 쓰는 흔한 경우에는 기본값이 맞으므로 그대로 둔다.
 */
export function resolveConsoleBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
  apiBaseUrl?: string,
): string {
  const configured = env.ARTEL_CONSOLE_BASE_URL?.trim();
  if (configured) {
    return normalizeBaseUrl(configured);
  }

  if (apiBaseUrl !== undefined && isLoopback(apiBaseUrl)) {
    throw new CliError(
      'missing_console_base_url',
      `ARTEL_API_BASE_URL is ${apiBaseUrl}, which is this machine, but ARTEL_CONSOLE_BASE_URL is not set and would default to ${DEFAULT_CONSOLE_BASE_URL}. A login code issued by that console lives in its own server and the local API cannot consume it, so set ARTEL_CONSOLE_BASE_URL to the console that talks to this API (for example ARTEL_CONSOLE_BASE_URL=http://localhost:5173).`,
    );
  }

  return normalizeBaseUrl(DEFAULT_CONSOLE_BASE_URL);
}

export function resolveConfig(env: NodeJS.ProcessEnv = process.env): CliConfig {
  const apiBaseUrl = resolveApiBaseUrl(env);
  return {
    apiBaseUrl,
    consoleBaseUrl: resolveConsoleBaseUrl(env, apiBaseUrl),
  };
}
