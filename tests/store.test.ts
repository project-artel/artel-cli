import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CliError } from '../src/errors.js';
import {
  enforcesFileMode,
  readCredential,
  removeCredential,
  writeCredential,
} from '../src/credentials/store.js';
import { CREDENTIAL_FILE_VERSION, type StoredCredential } from '../src/credentials/types.js';
import { createTempConfig, modeOf, type TempConfig } from './helpers.js';

let temp: TempConfig;
let env: NodeJS.ProcessEnv;

const credential: StoredCredential = {
  version: CREDENTIAL_FILE_VERSION,
  token: 'artel_stored_token_value',
  tokenId: '01JXSTORED',
  tokenName: 'artel-cli@laptop',
  createdAt: '2026-09-03T04:11:07Z',
  expiresAt: null,
  apiBaseUrl: 'https://api.example.test',
};

beforeEach(async () => {
  temp = await createTempConfig();
  env = { ARTEL_CONFIG_DIR: temp.configDir };
});

afterEach(async () => {
  await temp.cleanup();
});

describe('credentials file', () => {
  it('round-trips what it wrote', async () => {
    await writeCredential(credential, env);
    await expect(readCredential(env)).resolves.toEqual(credential);
  });

  it('returns null when the file is not there', async () => {
    await expect(readCredential(env)).resolves.toBeNull();
  });

  it('removes idempotently', async () => {
    await expect(removeCredential(env)).resolves.toBe(false);
    await writeCredential(credential, env);
    await expect(removeCredential(env)).resolves.toBe(true);
    await expect(removeCredential(env)).resolves.toBe(false);
  });

  it('refuses a file whose version it does not know', async () => {
    await writeCredential(credential, env);
    await fs.writeFile(temp.credentialsFile, JSON.stringify({ ...credential, version: 99 }), {
      mode: 0o600,
    });
    await expect(readCredential(env)).rejects.toMatchObject({ code: 'credential_file_version' });
  });

  it('refuses a file that is not valid JSON', async () => {
    await writeCredential(credential, env);
    await fs.writeFile(temp.credentialsFile, 'not json', { mode: 0o600 });
    await expect(readCredential(env)).rejects.toMatchObject({
      code: 'credential_file_unreadable',
    });
  });

  it('refuses a file that is missing a required field', async () => {
    await writeCredential(credential, env);
    const withoutToken: Record<string, unknown> = { ...credential };
    delete withoutToken.token;
    await fs.writeFile(temp.credentialsFile, JSON.stringify(withoutToken), { mode: 0o600 });
    const failure = await readCredential(env).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CliError);
    expect((failure as CliError).code).toBe('credential_file_unreadable');
  });
});

describe.runIf(enforcesFileMode())('POSIX permissions', () => {
  it('creates the directory 0700 and the file 0600', async () => {
    const written = await writeCredential(credential, env);
    expect(written.mode).toBe('0600');
    expect(await modeOf(temp.credentialsFile)).toBe('0600');
    expect(await modeOf(temp.configDir)).toBe('0700');
  });

  it('lands on 0600 even when a wide-open file was already there', async () => {
    await fs.mkdir(temp.configDir, { recursive: true });
    await fs.writeFile(temp.credentialsFile, '{}', { mode: 0o644 });
    await fs.chmod(temp.credentialsFile, 0o644);

    await writeCredential(credential, env);
    expect(await modeOf(temp.credentialsFile)).toBe('0600');
  });

  it('leaves no temporary file behind', async () => {
    await writeCredential(credential, env);
    const entries = await fs.readdir(temp.configDir);
    expect(entries).toEqual(['credentials.json']);
  });

  it('refuses to read a file that group or others can reach', async () => {
    await writeCredential(credential, env);
    await fs.chmod(temp.credentialsFile, 0o640);
    await expect(readCredential(env)).rejects.toMatchObject({ code: 'credential_file_mode' });
  });

  it('names the mode it found in the refusal', async () => {
    await writeCredential(credential, env);
    await fs.chmod(temp.credentialsFile, 0o644);
    const failure = (await readCredential(env).catch((error: unknown) => error)) as CliError;
    expect(failure.message).toContain('0644');
    // 평문 token 은 어떤 에러 메시지에도 없다.
    expect(failure.message).not.toContain(credential.token);
  });
});
