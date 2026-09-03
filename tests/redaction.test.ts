import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runAuthLogin } from '../src/commands/auth/login.js';
import { runCli } from '../src/run.js';
import type { CliError } from '../src/errors.js';
import {
  callBack,
  createMemorySink,
  createTempConfig,
  relayQuery,
  startFakeOrchestration,
  type MemorySink,
  type TempConfig,
} from './helpers.js';

const ISSUED_TOKEN = 'artel_pC7xQ2vLmN8sT4wR0yZ1bK5hJ9gF3dA6';

let temp: TempConfig;
let observedChallenge = '';

beforeEach(async () => {
  temp = await createTempConfig();
  observedChallenge = '';
});

afterEach(async () => {
  await temp.cleanup();
});

async function loginAgainst(
  failWith: { status: number; body: string } | undefined,
): Promise<{ sink: MemorySink; failure: CliError | null }> {
  const api = await startFakeOrchestration({
    expectedCode: 'code',
    expectedChallenge: () => observedChallenge,
    token: ISSUED_TOKEN,
    ...(failWith === undefined ? {} : { failWith }),
  });
  const sink = createMemorySink();
  let failure: CliError | null = null;

  try {
    await runAuthLogin(
      { json: true, name: 'artel-cli@test', expiresInDays: 90 },
      sink,
      {
        ARTEL_CONFIG_DIR: temp.configDir,
        ARTEL_API_BASE_URL: api.baseUrl,
        ARTEL_CONSOLE_BASE_URL: 'https://console.example.test',
      },
      (notify) => ({
        openBrowser: async (url) => {
          const relay = relayQuery(url);
          observedChallenge = relay.challenge;
          await callBack(relay.port, { code: 'code', state: relay.state });
        },
        fetchImpl: globalThis.fetch,
        randomBytes: crypto.randomBytes,
        notify,
        timeoutMs: 5_000,
      }),
    );
  } catch (error) {
    failure = error as CliError;
  } finally {
    await api.close();
  }

  return { sink, failure };
}

describe('the token never reaches the output', () => {
  it('keeps the issued token out of stdout and stderr on a successful login', async () => {
    const { sink, failure } = await loginAgainst(undefined);

    expect(failure).toBeNull();
    expect(sink.everything()).not.toContain(ISSUED_TOKEN);
    // 확인: token 은 파일에는 실제로 들어 있다. 위 단언이 공허하지 않다는 증거다.
    expect(await fs.readFile(temp.credentialsFile, 'utf8')).toContain(ISSUED_TOKEN);
  });

  it('keeps a token echoed back in a 401 body out of the error message', async () => {
    const { sink, failure } = await loginAgainst({
      status: 401,
      body: JSON.stringify({
        code: 'unauthorized',
        message: 'session expired',
        token: ISSUED_TOKEN,
      }),
    });

    expect(failure?.code).toBe('server_error');
    expect(failure?.message).not.toContain(ISSUED_TOKEN);
    expect(failure?.message).toContain('unauthorized');
    expect(sink.everything()).not.toContain(ISSUED_TOKEN);
  });

  it('keeps ARTEL_TOKEN out of status output', async () => {
    const sink = createMemorySink();
    await runCli(['auth', 'status'], sink, {
      ARTEL_CONFIG_DIR: temp.configDir,
      ARTEL_TOKEN: ISSUED_TOKEN,
    });
    expect(sink.everything()).not.toContain(ISSUED_TOKEN);

    const json = createMemorySink();
    await runCli(['auth', 'status', '--json'], json, {
      ARTEL_CONFIG_DIR: temp.configDir,
      ARTEL_TOKEN: ISSUED_TOKEN,
    });
    expect(json.everything()).not.toContain(ISSUED_TOKEN);
    expect(json.stdout[0]).not.toContain('"token"');
  });
});
