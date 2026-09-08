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

/**
 * `--api-url`/`--console-url` 로 받은 값. 있으면 같은 이름의 환경 변수보다 이긴다.
 * `resolveConfig` 호출부마다 두 인자를 따로 threading 하지 않으려고 하나로 묶었다.
 */
export interface ConfigOverrides {
  apiBaseUrl?: string | undefined;
  consoleBaseUrl?: string | undefined;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

/** 절대 http/https URL 이 아니면 나중에 알 수 없는 network error 로 죽는 대신 여기서 거절한다. */
function assertAbsoluteHttpUrl(value: string, sourceLabel: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new CliError(
      'invalid_base_url',
      `${sourceLabel} is "${value}", which is not a valid URL. Use an absolute URL such as https://api.example.com.`,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CliError(
      'invalid_base_url',
      `${sourceLabel} is "${value}", which is a "${parsed.protocol}" URL. Use an absolute http:// or https:// URL.`,
    );
  }
}

/**
 * orchestration API 의 운영 host 는 orchestration 저장소에도 artel-home 저장소에도
 * 문자열로 적혀 있지 않다(artel-home 은 `VITE_ORCHESTRATION_URL` 로 주입받는다).
 * 기본값을 지어내면 staging token 을 운영에 쏘는 사고가 조용히 일어나므로,
 * 기본값이 정해질 때까지 `--api-url`/`ARTEL_API_BASE_URL` 을 필수로 둔다.
 */
export type ApiBaseUrlSource = 'flag' | 'env' | 'file';

export interface EffectiveApiBaseUrl {
  /** 정규화만 한 값. 유효한 URL 인지는 보지 않는다. */
  value: string | null;
  source: ApiBaseUrlSource | null;
}

/**
 * 환경 변수와 자격증명 파일 사이의 순서를 아는 유일한 자리. flag 층과 검증은 얹지 않는다.
 *
 * `auth status` 가 이것을 그대로 부른다. 보고하는 명령이 값이 이상하다는 이유로 죽으면 안 되고,
 * 그 값이 실제로 쓰이는 자리에서 `invalid_base_url` 로 걸린다.
 *
 * `storedApiBaseUrl` 은 부르는 쪽이 이미 읽은 자격증명 파일의 값이다. 이 module 이 직접 읽지
 * 않는 이유는 의존 방향이다 — `commands` 가 `credentials` 와 `config` 를 둘 다 부르고 그 반대
 * 간선은 없다. 여기서 파일을 읽으면 그 방향이 깨진다.
 *
 * `ARTEL_TOKEN` 으로 인증한 경우 부르는 쪽이 `null` 을 넘긴다. 환경 변수로 들어온 token 에는
 * 짝지어진 주소가 없고, 남의 파일에 적힌 주소를 그 token 에 붙이면 CI 가 자기가 어디에 붙는지
 * 모르게 된다.
 */
export function effectiveApiBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
  storedApiBaseUrl?: string | null,
): EffectiveApiBaseUrl {
  const envValue = env.ARTEL_API_BASE_URL?.trim();
  if (envValue) {
    return { value: normalizeBaseUrl(envValue), source: 'env' };
  }

  const storedValue = storedApiBaseUrl?.trim();
  if (storedValue) {
    return { value: normalizeBaseUrl(storedValue), source: 'file' };
  }

  return { value: null, source: null };
}

const SOURCE_LABELS: Record<ApiBaseUrlSource, string> = {
  flag: '--api-url',
  env: 'ARTEL_API_BASE_URL',
  file: 'the apiBaseUrl in the credentials file',
};

export function resolveApiBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
  override?: string,
  storedApiBaseUrl?: string | null,
): string {
  const flagValue = override?.trim();
  const resolved: EffectiveApiBaseUrl = flagValue
    ? { value: normalizeBaseUrl(flagValue), source: 'flag' }
    : effectiveApiBaseUrl(env, storedApiBaseUrl);

  if (resolved.value === null || resolved.source === null) {
    throw new CliError(
      'missing_api_base_url',
      'The orchestration API host is not set. The orchestration API host has no default yet, so pass --api-url, set ARTEL_API_BASE_URL, or run "artel auth login --api-url <url>" once — the address that login used is stored with the credential and becomes the default for later commands.',
    );
  }

  assertAbsoluteHttpUrl(resolved.value, SOURCE_LABELS[resolved.source]);
  return resolved.value;
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
 *
 * `apiBaseUrl` 은 이미 `--api-url`/`ARTEL_API_BASE_URL` 중 어느 쪽에서 왔든 정규화가 끝난
 * 유효 값이다 — 이 함수는 그 출처를 다시 구분하지 않고 그 값 자체로 loopback 여부만 본다.
 */
export function resolveConsoleBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
  apiBaseUrl?: string,
  override?: string,
): string {
  const flagValue = override?.trim();
  const envValue = env.ARTEL_CONSOLE_BASE_URL?.trim();
  const configured = flagValue || envValue;
  if (configured) {
    const sourceLabel = flagValue ? '--console-url' : 'ARTEL_CONSOLE_BASE_URL';
    assertAbsoluteHttpUrl(configured, sourceLabel);
    return normalizeBaseUrl(configured);
  }

  if (apiBaseUrl !== undefined && isLoopback(apiBaseUrl)) {
    throw new CliError(
      'missing_console_base_url',
      `The API base URL is ${apiBaseUrl}, which is this machine, but no console base URL was given and it would default to ${DEFAULT_CONSOLE_BASE_URL}. A login code issued by that console lives in its own server and the local API cannot consume it, so pass --console-url or set ARTEL_CONSOLE_BASE_URL to the console that talks to this API (for example --console-url http://localhost:5173).`,
    );
  }

  return normalizeBaseUrl(DEFAULT_CONSOLE_BASE_URL);
}

export function resolveConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: ConfigOverrides = {},
  storedApiBaseUrl?: string | null,
): CliConfig {
  const apiBaseUrl = resolveApiBaseUrl(env, overrides.apiBaseUrl, storedApiBaseUrl);
  return {
    apiBaseUrl,
    consoleBaseUrl: resolveConsoleBaseUrl(env, apiBaseUrl, overrides.consoleBaseUrl),
  };
}
