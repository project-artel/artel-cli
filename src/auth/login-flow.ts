import crypto from 'node:crypto';

import { exchangeCliToken, type CliTokenResponse, type FetchLike } from '../http/client.js';
import { openBrowser as spawnBrowser, type BrowserOpener } from './browser.js';
import { startLoopbackListener } from './loopback.js';
import { codeChallengeFor, createCodeVerifier, createState, type RandomBytes } from './pkce.js';

/**
 * 서버의 login code TTL 이 기본 5분이므로 그 안이고, 비밀번호와 MFA 를 넣기에는 넉넉하다.
 */
export const DEFAULT_LOGIN_TIMEOUT_MS = 180_000;

/**
 * 콘솔의 relay page. 기존 `challenge`/`port`/`state` 세 파라미터를 이름·형식 그대로 쓰고
 * `kind=cli` 하나만 더한다.
 *
 * 서버 쪽에 아직 없는 것 — ARTEL-780 이 짓지 않는 범위다:
 * 1. artel-home 의 `sdkLoginRequest.ts` 가 `kind` 를 받아 `createSdkLoginCode` 로 넘기는 것.
 *    지금 relay page 는 모르는 query 파라미터를 그냥 버린다.
 * 2. `SdkLoginCodeStore` 의 value 가 `"$userId:$codeChallenge"` 라는 `:` 결합 문자열이라
 *    `kind` 를 같이 담으려면 JSON 값으로 바뀌어야 하는 것.
 * 3. `POST /api/auth/cli-tokens/exchange` endpoint 자체.
 *
 * 그래서 이 flow 는 실제 서버를 상대로는 아직 끝까지 가지 못한다. 3번이 없을 때 무엇을
 * 말할지는 `http/client.ts` 의 404 처리에 적혀 있다.
 */
export const RELAY_PATH = '/sdk-login';

export interface LoginFlowOptions {
  apiBaseUrl: string;
  consoleBaseUrl: string;
  tokenName: string;
  expiresInDays: number | null;
}

/**
 * 이 주입 지점이 브라우저 없이 로그인을 테스트하는 유일한 손잡이다. 테스트가 브라우저
 * 역할을 맡아 `openBrowser` 로 받은 URL 에서 `port` 와 `state` 를 뜯어내고 직접 콜백을 친다.
 */
export interface LoginFlowDeps {
  openBrowser: BrowserOpener;
  fetchImpl: FetchLike;
  randomBytes: RandomBytes;
  notify: (message: string) => void;
  timeoutMs: number;
}

export function defaultLoginFlowDeps(notify: (message: string) => void): LoginFlowDeps {
  return {
    openBrowser: spawnBrowser,
    fetchImpl: globalThis.fetch,
    randomBytes: crypto.randomBytes,
    notify,
    timeoutMs: DEFAULT_LOGIN_TIMEOUT_MS,
  };
}

export function buildRelayUrl(
  consoleBaseUrl: string,
  challenge: string,
  port: number,
  state: string,
): string {
  const url = new URL(RELAY_PATH, `${consoleBaseUrl}/`);
  url.searchParams.set('challenge', challenge);
  url.searchParams.set('port', String(port));
  url.searchParams.set('state', state);
  url.searchParams.set('kind', 'cli');
  return url.toString();
}

/**
 * 브라우저에는 일회용 code 만 흐르고, `artel_` token 은 CLI 가 verifier 를 들고 하는
 * exchange 응답에서 딱 한 번 나온다.
 */
export async function runLoginFlow(
  options: LoginFlowOptions,
  deps: LoginFlowDeps,
): Promise<CliTokenResponse> {
  const verifier = createCodeVerifier(deps.randomBytes);
  const challenge = codeChallengeFor(verifier);
  const state = createState(deps.randomBytes);

  const listener = await startLoopbackListener(state);
  try {
    const relayUrl = buildRelayUrl(options.consoleBaseUrl, challenge, listener.port, state);

    // 열기가 실패해도 계속 기다리므로 URL 을 먼저 찍는다. headless 에서도 사람이 손으로 연다.
    deps.notify(`Open this URL to finish signing in:\n  ${relayUrl}`);
    try {
      await deps.openBrowser(relayUrl);
    } catch (error) {
      deps.notify(
        `Could not open a browser automatically (${error instanceof Error ? error.message : 'unknown error'}). Open the URL above by hand.`,
      );
    }

    const code = await listener.waitForCode(deps.timeoutMs);
    return await exchangeCliToken(
      options.apiBaseUrl,
      {
        code,
        codeVerifier: verifier,
        name: options.tokenName,
        expiresInDays: options.expiresInDays,
      },
      deps.fetchImpl,
    );
  } finally {
    await listener.close();
  }
}
