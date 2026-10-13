import { CliError } from './errors.js';

/**
 * 아무 주소도 주지 않았을 때 쓰는 orchestration API. SDK 의 `Server.cs` 기본 host 와 같은
 * stage 배포다. 운영 API 가 생기면 이 값과 아래 `PAIRED_CONSOLE_BASE_URLS` 를 함께 바꾼다.
 */
export const DEFAULT_API_BASE_URL = 'https://stage-orch.artel.kr';

/**
 * API origin 과 그 API 에 붙은 console(artel-home) origin 의 짝. relay page `/sdk-login` 이
 * console 에 있다. `https://artel.kr` 은 소개 페이지이고 어느 API 와도 짝이 아니다.
 */
const PAIRED_CONSOLE_BASE_URLS: Readonly<Record<string, string>> = {
  'https://stage-orch.artel.kr': 'https://home.stage.artel.kr',
};

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

/** `default` 는 flag, 환경 변수, 자격증명 파일 어디에도 값이 없어 `DEFAULT_API_BASE_URL` 을 쓴 경우다. */
export type ApiBaseUrlSource = 'flag' | 'env' | 'file' | 'default';

export interface EffectiveApiBaseUrl {
  /** 정규화만 한 값. 유효한 URL 인지는 보지 않는다. */
  value: string;
  source: ApiBaseUrlSource;
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

  return { value: DEFAULT_API_BASE_URL, source: 'default' };
}

const SOURCE_LABELS: Record<ApiBaseUrlSource, string> = {
  flag: '--api-url',
  env: 'ARTEL_API_BASE_URL',
  file: 'the apiBaseUrl in the credentials file',
  default: 'the built-in default API base URL',
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

function originOf(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return null;
  }
}

/**
 * console 주소는 API 주소와 반드시 짝이 맞아야 한다.
 *
 * 로그인은 console 이 코드를 발급하고 API 가 그것을 소비하는 왕복이다. 둘이 다른 배포를
 * 가리키면 코드가 한쪽 Redis 에만 있어 교환이 반드시 실패한다. 게임에 넘길 때도 같다:
 * `-artel-frontend` 가 다른 배포를 가리키는 빌드는, 오버레이가 로그인을 물어야 하는 순간에
 * 사람을 엉뚱한 곳으로 보낸다.
 *
 * 그래서 console 을 말해 주지 않으면 `PAIRED_CONSOLE_BASE_URLS` 에서 API 의 짝을 찾고, 짝이
 * 없는 API 는 아무 console 로 때우지 않고 거절한다. `apiBaseUrl` 이 없으면 기본 API 의 짝을 쓴다.
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

  const api = apiBaseUrl ?? DEFAULT_API_BASE_URL;
  const origin = originOf(api);
  const paired = origin === null ? undefined : PAIRED_CONSOLE_BASE_URLS[origin];
  if (paired !== undefined) {
    return paired;
  }

  const example = isLoopback(api) ? 'http://localhost:5173' : 'https://console.example.com';
  throw new CliError(
    'missing_console_base_url',
    `The API base URL is ${api}, and no console base URL is known for it. A login code issued by another console lives in that console's server and this API cannot consume it, so pass --console-url or set ARTEL_CONSOLE_BASE_URL to the console that talks to this API (for example --console-url ${example}).`,
  );
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
