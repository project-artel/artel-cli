import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fingerprint, reportOf, resolveCredential } from '../src/credentials/resolve.js';
import { writeCredential } from '../src/credentials/store.js';
import { CREDENTIAL_FILE_VERSION } from '../src/credentials/types.js';
import { createTempConfig, type TempConfig } from './helpers.js';

let temp: TempConfig;

const storedToken = 'artel_file_token_value';

async function writeStoredCredential(env: NodeJS.ProcessEnv): Promise<void> {
  await writeCredential(
    {
      version: CREDENTIAL_FILE_VERSION,
      token: storedToken,
      tokenId: '01JXFILE',
      tokenName: 'artel-cli@laptop',
      createdAt: '2026-09-03T04:11:07Z',
      expiresAt: '2026-12-02T04:11:07Z',
      apiBaseUrl: 'https://api.example.test',
    },
    env,
  );
}

beforeEach(async () => {
  temp = await createTempConfig();
});

afterEach(async () => {
  await temp.cleanup();
});

describe('credential resolution order', () => {
  it('lets ARTEL_TOKEN win over the credentials file', async () => {
    const env: NodeJS.ProcessEnv = { ARTEL_CONFIG_DIR: temp.configDir };
    await writeStoredCredential(env);

    const resolution = await resolveCredential({ ...env, ARTEL_TOKEN: 'artel_env_token_value' });

    expect(resolution.credential?.source).toBe('env');
    expect(resolution.credential?.token).toBe('artel_env_token_value');
    expect(resolution.envVarState).toBe('used');
    expect(resolution.file.exists).toBe(true);

    const report = reportOf(resolution);
    expect(report.fingerprint).toBe(fingerprint('artel_env_token_value'));
    // 환경 변수는 이 값들을 들고 있지 않다.
    expect(report.tokenId).toBeNull();
    expect(report.tokenName).toBeNull();
    expect(report.expiresAt).toBeNull();
    expect(report.apiBaseUrl).toBeNull();
  });

  it('trims ARTEL_TOKEN before using it', async () => {
    const resolution = await resolveCredential({
      ARTEL_CONFIG_DIR: temp.configDir,
      ARTEL_TOKEN: '  artel_padded  ',
    });
    expect(resolution.credential?.token).toBe('artel_padded');
  });

  it('reads an empty ARTEL_TOKEN as unset and falls through to the file', async () => {
    const env: NodeJS.ProcessEnv = { ARTEL_CONFIG_DIR: temp.configDir };
    await writeStoredCredential(env);

    const resolution = await resolveCredential({ ...env, ARTEL_TOKEN: '   ' });

    expect(resolution.envVarState).toBe('empty');
    expect(resolution.credential?.source).toBe('file');
    expect(resolution.credential?.token).toBe(storedToken);
    expect(reportOf(resolution).tokenId).toBe('01JXFILE');
  });

  it('reports no credential when neither the variable nor the file is there', async () => {
    const resolution = await resolveCredential({ ARTEL_CONFIG_DIR: temp.configDir });
    const report = reportOf(resolution);

    expect(report.authenticated).toBe(false);
    expect(report.source).toBeNull();
    expect(report.fingerprint).toBeNull();
    expect(report.credentialsFileExists).toBe(false);
    expect(resolution.envVarState).toBe('unset');
  });

  it('does not read the file at all when ARTEL_TOKEN wins', async () => {
    // 권한이 망가진 파일 하나가 CI 를 멈추면 안 된다.
    const env: NodeJS.ProcessEnv = { ARTEL_CONFIG_DIR: temp.configDir };
    await writeStoredCredential(env);
    await fs.chmod(temp.credentialsFile, 0o644);

    const resolution = await resolveCredential({ ...env, ARTEL_TOKEN: 'artel_env_token_value' });
    expect(resolution.credential?.source).toBe('env');
  });

  it('derives the fingerprint as the first 12 hex of sha256(token)', () => {
    expect(fingerprint('artel_env_token_value')).toMatch(/^[0-9a-f]{12}$/);
    expect(fingerprint('a')).not.toBe(fingerprint('b'));
  });
});
