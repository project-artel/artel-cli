import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runAuthStatus } from '../src/commands/auth/status.js';
import { writeCredential } from '../src/credentials/store.js';
import { CREDENTIAL_FILE_VERSION } from '../src/credentials/types.js';
import type { CliError } from '../src/errors.js';
import type { StatusPayload } from '../src/output/contract.js';
import { resolveQaContext } from '../src/qa/context.js';
import { createMemorySink, createTempConfig, type TempConfig } from './helpers.js';

const STORED_API_BASE_URL = 'https://stored.example.test';

let temp: TempConfig;

beforeEach(async () => {
  temp = await createTempConfig();
});

afterEach(async () => {
  await temp.cleanup();
});

async function signIn(): Promise<void> {
  await writeCredential(
    {
      version: CREDENTIAL_FILE_VERSION,
      token: 'artel_stored',
      tokenId: '01JXSTORED',
      tokenName: 'artel-cli@laptop',
      createdAt: '2026-09-03T04:11:07Z',
      expiresAt: null,
      apiBaseUrl: STORED_API_BASE_URL,
    },
    { ARTEL_CONFIG_DIR: temp.configDir },
  );
}

/**
 * `qa/context.ts` 로 대표한다. `case`, `scenario`, `testRuns`, `doc` 의 context module 도 같은
 * 순서로 같은 값을 넘기므로, 하나가 무너지면 나머지도 같은 자리에서 무너진다.
 */
describe('a signed-in machine needs no address flag', () => {
  it('takes the address the credentials file was written with', async () => {
    await signIn();

    const context = await resolveQaContext({ ARTEL_CONFIG_DIR: temp.configDir }, undefined);

    expect(context.apiBaseUrl).toBe(STORED_API_BASE_URL);
  });

  it('lets ARTEL_API_BASE_URL win over the stored address', async () => {
    await signIn();

    const context = await resolveQaContext(
      {
        ARTEL_CONFIG_DIR: temp.configDir,
        ARTEL_API_BASE_URL: 'https://env.example.test',
      },
      undefined,
    );

    expect(context.apiBaseUrl).toBe('https://env.example.test');
  });

  /**
   * 환경 변수로 들어온 token 에는 짝지어진 주소가 없다. 남의 파일에 적힌 주소를 그 token 에
   * 붙이면 CI 가 자기가 어디에 붙는지 모르게 된다.
   */
  it('does not lend the stored address to an ARTEL_TOKEN credential', async () => {
    await signIn();

    const failure = (await resolveQaContext(
      { ARTEL_CONFIG_DIR: temp.configDir, ARTEL_TOKEN: 'artel_from_env' },
      undefined,
    ).catch((error: unknown) => error)) as CliError;

    expect(failure.code).toBe('missing_api_base_url');
  });

  /**
   * 로그인도 안 했고 주소도 없으면 고치는 방법이 하나뿐이다. 두 오류가 다 참일 때 그쪽을
   * 말한다.
   */
  it('says which one thing to do when neither the credential nor the address exists', async () => {
    const failure = (await resolveQaContext(
      { ARTEL_CONFIG_DIR: temp.configDir },
      undefined,
    ).catch((error: unknown) => error)) as CliError;

    expect(failure.code).toBe('no_credential');
  });
});

describe('artel auth status reports the address commands would use', () => {
  it('names the credentials file as the source', async () => {
    await signIn();
    const sink = createMemorySink();

    await runAuthStatus({ json: true }, sink, { ARTEL_CONFIG_DIR: temp.configDir });

    const payload = sink.lastJson<StatusPayload>();
    expect(payload.apiBaseUrl).toBe(STORED_API_BASE_URL);
    expect(payload.apiBaseUrlSource).toBe('file');
  });

  it('names the environment variable when it wins', async () => {
    await signIn();
    const sink = createMemorySink();

    await runAuthStatus({ json: true }, sink, {
      ARTEL_CONFIG_DIR: temp.configDir,
      ARTEL_API_BASE_URL: 'https://env.example.test',
    });

    const payload = sink.lastJson<StatusPayload>();
    expect(payload.apiBaseUrl).toBe('https://env.example.test');
    expect(payload.apiBaseUrlSource).toBe('env');
  });

  it('reports no address at all rather than failing', async () => {
    const sink = createMemorySink();

    await runAuthStatus({ json: true }, sink, { ARTEL_CONFIG_DIR: temp.configDir });

    const payload = sink.lastJson<StatusPayload>();
    expect(payload.apiBaseUrl).toBeNull();
    expect(payload.apiBaseUrlSource).toBeNull();
  });

  it('writes the source into the human output too', async () => {
    await signIn();
    const sink = createMemorySink();

    await runAuthStatus({ json: false }, sink, { ARTEL_CONFIG_DIR: temp.configDir });

    expect(sink.stdout.join('\n')).toContain(`${STORED_API_BASE_URL} (from credentials file)`);
  });
});
