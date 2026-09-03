import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runAuthLogin } from '../src/commands/auth/login.js';
import { startLoopbackListener } from '../src/auth/loopback.js';
import { readCredential } from '../src/credentials/store.js';
import type { CliError } from '../src/errors.js';
import type { LoginPayload } from '../src/output/contract.js';
import type { LoginFlowDeps } from '../src/auth/login-flow.js';
import {
  callBack,
  createMemorySink,
  createTempConfig,
  relayQuery,
  startFakeOrchestration,
  type FakeOrchestration,
  type MemorySink,
  type TempConfig,
} from './helpers.js';

const ISSUED_TOKEN = 'artel_secret_token_that_must_never_be_printed';
const ONE_TIME_CODE = 'one-time-login-code';
const CONSOLE_BASE_URL = 'https://console.example.test';

let temp: TempConfig;
let api: FakeOrchestration;
/** 브라우저에 실려 나간 challenge. 가짜 서버가 verifier 를 검증할 때 쓴다. */
let observedChallenge = '';

interface LoginRun {
  sink: MemorySink;
  failure: CliError | null;
}

async function login(
  browser: (url: string) => Promise<void>,
  overrides: Partial<Pick<LoginFlowDeps, 'timeoutMs'>> = {},
  expiresInDays: number | null = 90,
): Promise<LoginRun> {
  const sink = createMemorySink();
  const env: NodeJS.ProcessEnv = {
    ARTEL_CONFIG_DIR: temp.configDir,
    ARTEL_API_BASE_URL: api.baseUrl,
    ARTEL_CONSOLE_BASE_URL: CONSOLE_BASE_URL,
  };

  let failure: CliError | null = null;
  try {
    await runAuthLogin(
      { json: true, name: 'artel-cli@test', expiresInDays },
      sink,
      env,
      (notify) => ({
        openBrowser: browser,
        fetchImpl: globalThis.fetch,
        randomBytes: crypto.randomBytes,
        notify,
        timeoutMs: overrides.timeoutMs ?? 5_000,
      }),
    );
  } catch (error) {
    failure = error as CliError;
  }
  return { sink, failure };
}

/** 브라우저 역할. relay URL 에서 port 와 state 를 뜯어내 콜백을 직접 친다. */
function browserThatSucceeds(): (url: string) => Promise<void> {
  return async (url) => {
    const relay = relayQuery(url);
    observedChallenge = relay.challenge;
    await callBack(relay.port, { code: ONE_TIME_CODE, state: relay.state });
  };
}

beforeEach(async () => {
  temp = await createTempConfig();
  observedChallenge = '';
  api = await startFakeOrchestration({
    expectedCode: ONE_TIME_CODE,
    expectedChallenge: () => observedChallenge,
    token: ISSUED_TOKEN,
  });
});

afterEach(async () => {
  await api.close();
  await temp.cleanup();
});

describe('artel auth login', () => {
  it('completes the PKCE round trip and stores the issued token', async () => {
    const { sink, failure } = await login(browserThatSucceeds());
    expect(failure).toBeNull();

    const payload = sink.lastJson<LoginPayload>();
    expect(payload.authenticated).toBe(true);
    expect(payload.source).toBe('file');
    expect(payload.tokenId).toBe('01JXTOKENID');
    expect(payload.apiBaseUrl).toBe(api.baseUrl);
    expect(payload.fingerprint).toMatch(/^[0-9a-f]{12}$/);

    // 가짜 서버가 verifier 를 다시 해시해 challenge 와 맞는지 이미 확인했다.
    expect(api.exchanges).toHaveLength(1);
    expect(api.exchanges[0]?.name).toBe('artel-cli@test');
    expect(api.exchanges[0]?.expiresInDays).toBe(90);
    expect(api.exchanges[0]?.codeVerifier).toHaveLength(43);

    const stored = await readCredential({ ARTEL_CONFIG_DIR: temp.configDir });
    expect(stored?.token).toBe(ISSUED_TOKEN);
  });

  it('opens the relay page with challenge, port, state and kind=cli', async () => {
    let openedUrl = '';
    await login(async (url) => {
      openedUrl = url;
      const relay = relayQuery(url);
      observedChallenge = relay.challenge;
      await callBack(relay.port, { code: ONE_TIME_CODE, state: relay.state });
    });

    const parsed = new URL(openedUrl);
    expect(parsed.origin).toBe(CONSOLE_BASE_URL);
    expect(parsed.pathname).toBe('/sdk-login');
    expect([...parsed.searchParams.keys()].sort()).toEqual(['challenge', 'kind', 'port', 'state']);
    expect(parsed.searchParams.get('kind')).toBe('cli');

    const port = Number.parseInt(parsed.searchParams.get('port') ?? '0', 10);
    expect(port).toBeGreaterThanOrEqual(1024);
    expect(port).toBeLessThanOrEqual(65535);
  });

  it('sends null for expiresInDays when the token should never expire', async () => {
    await login(browserThatSucceeds(), {}, null);
    expect(api.exchanges[0]?.expiresInDays).toBeNull();
  });

  it('prints the URL before trying to open it, and keeps waiting when opening fails', async () => {
    let relayUrl = '';
    const { sink, failure } = await login((url) => {
      relayUrl = url;
      const relay = relayQuery(url);
      observedChallenge = relay.challenge;
      // 열기가 실패해도 계속 기다려야 한다. 사람이 손으로 열 수 있기 때문이다.
      setTimeout(() => {
        void callBack(relay.port, { code: ONE_TIME_CODE, state: relay.state });
      }, 10);
      return Promise.reject(new Error('no browser here'));
    });

    expect(failure).toBeNull();
    expect(sink.stderr.join('\n')).toContain(relayUrl);
    expect(sink.stderr.join('\n')).toContain('Could not open a browser automatically');
  });

  it('keeps the progress notices out of stdout so --json stays one line', async () => {
    const { sink } = await login(browserThatSucceeds());
    expect(sink.stdout).toHaveLength(1);
    expect(sink.stderr.length).toBeGreaterThan(0);
  });
});

describe('loopback listener', () => {
  it('binds to 127.0.0.1 on a port the console will accept', async () => {
    const listener = await startLoopbackListener('state-value');
    try {
      expect(listener.port).toBeGreaterThanOrEqual(1024);
      expect(listener.port).toBeLessThanOrEqual(65535);
      const response = await callBack(listener.port, {}, { path: '/' });
      expect(response.status).toBe(404);
    } finally {
      await listener.close();
    }
  });

  it('answers 404 to anything that is not GET /callback', async () => {
    const listener = await startLoopbackListener('state-value');
    try {
      expect((await callBack(listener.port, {}, { path: '/other' })).status).toBe(404);
      expect((await callBack(listener.port, {}, { method: 'POST' })).status).toBe(404);
    } finally {
      await listener.close();
    }
  });

  it('answers 400 when the Host header is not the loopback address', async () => {
    const listener = await startLoopbackListener('state-value');
    try {
      const response = await callBack(
        listener.port,
        { code: 'c', state: 'state-value' },
        { host: 'attacker.example' },
      );
      expect(response.status).toBe(400);
    } finally {
      await listener.close();
    }
  });

  it('does not echo the code back in the response body', async () => {
    const listener = await startLoopbackListener('state-value');
    const waiting = listener.waitForCode(2_000);
    const response = await callBack(listener.port, {
      code: 'sensitive-code',
      state: 'state-value',
    });
    await expect(waiting).resolves.toBe('sensitive-code');
    expect(response.body).not.toContain('sensitive-code');
    expect(response.status).toBe(200);
  });

  it('rejects a mismatched state with 400 without ending the flow', async () => {
    let mismatched = 0;
    const { sink, failure } = await login(async (url) => {
      const relay = relayQuery(url);
      observedChallenge = relay.challenge;
      const first = await callBack(relay.port, { code: ONE_TIME_CODE, state: 'wrong-state' });
      mismatched = first.status;
      await callBack(relay.port, { code: ONE_TIME_CODE, state: relay.state });
    });

    expect(mismatched).toBe(400);
    expect(failure).toBeNull();
    expect(sink.lastJson<LoginPayload>().authenticated).toBe(true);
  });

  it('stops waiting after ten unexpected requests', async () => {
    const { failure } = await login(async (url) => {
      const relay = relayQuery(url);
      observedChallenge = relay.challenge;
      for (let i = 0; i < 10; i += 1) {
        await callBack(relay.port, { code: ONE_TIME_CODE, state: 'wrong-state' });
      }
    });

    expect(failure?.code).toBe('loopback_abuse');
  });

  it('fails with login_timeout when nothing calls back', async () => {
    // sleep 대신 주입한 마감을 쓴다.
    const { failure } = await login(() => Promise.resolve(), { timeoutMs: 50 });
    expect(failure?.code).toBe('login_timeout');
  });

  it('fails with login_denied when the console reports a refusal', async () => {
    const { failure } = await login(async (url) => {
      const relay = relayQuery(url);
      observedChallenge = relay.challenge;
      await callBack(relay.port, { error: 'access_denied', state: relay.state });
    });
    expect(failure?.code).toBe('login_denied');
  });
});
