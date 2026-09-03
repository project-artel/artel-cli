import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { CliError } from '../errors.js';
import { credentialsDir, credentialsPath } from './paths.js';
import { CREDENTIAL_FILE_VERSION, type StoredCredential } from './types.js';

/**
 * NTFS 는 POSIX mode bit 를 강제하지 않고 Node 의 `chmod` 는 read-only 속성만 건드린다.
 * 그래서 Windows 에서는 0600 을 주장하지 않고, 파일이 사용자 프로필 ACL 로 보호된다고만
 * 말한다. `icacls` 를 shell out 하지는 않는다 — 로그인 명령에 테스트할 수 없는 실패
 * 표면을 새로 다는 일이다.
 */
export function enforcesFileMode(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32';
}

export function formatMode(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(4, '0');
}

export interface CredentialFileStat {
  exists: boolean;
  /** POSIX 는 `"0600"` 같은 4자리 8진수, Windows 는 `null`. */
  mode: string | null;
}

export async function statCredentialFile(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CredentialFileStat> {
  const file = credentialsPath(env);
  try {
    const stats = await fs.stat(file);
    return { exists: true, mode: enforcesFileMode() ? formatMode(stats.mode) : null };
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) {
      return { exists: false, mode: null };
    }
    throw new CliError(
      'credential_file_unreadable',
      `Cannot inspect the credentials file at ${file}: ${describeErrno(error)}`,
    );
  }
}

/** 파일이 없으면 `null`. 있는데 읽을 수 없으면 던진다. */
export async function readCredential(
  env: NodeJS.ProcessEnv = process.env,
): Promise<StoredCredential | null> {
  const file = credentialsPath(env);

  let raw: string;
  try {
    const stats = await fs.stat(file);
    assertNotGroupOrWorldAccessible(file, stats.mode);
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) {
      return null;
    }
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError(
      'credential_file_unreadable',
      `Cannot read the credentials file at ${file}: ${describeErrno(error)}`,
    );
  }

  return parseStoredCredential(raw, file);
}

/**
 * 0600 을 사후 수정이 아니라 생성 시점에 보장한다. 쓰고 나서 `chmod` 하는 순서는 쓰지
 * 않는다 — `open` 과 `chmod` 사이의 짧은 창 동안 파일이 남에게 읽힌다.
 */
export async function writeCredential(
  credential: StoredCredential,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CredentialFileStat> {
  const dir = credentialsDir(env);
  const file = credentialsPath(env);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });

  const tmp = path.join(
    dir,
    `credentials.json.${String(process.pid)}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  const body = `${JSON.stringify(credential, null, 2)}\n`;

  try {
    // `wx` 라서 이미 있으면 실패한다. 즉 우리가 만든 파일임이 보장되고, 그래야 `open` 의
    // mode 인자가 실제로 적용된다 — mode 는 기존 파일에는 무시된다.
    const handle = await fs.open(tmp, 'wx', 0o600);
    try {
      if (enforcesFileMode()) {
        // umask 가 owner write 까지 깎아 0400 으로 열린 경우를 정확히 0600 으로 되돌린다.
        // 아직 아무도 열 수 없는 임시 파일이라 넓히는 위험이 없다.
        await handle.chmod(0o600);
      }
      await handle.writeFile(body, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    // 같은 디렉터리 안이라 atomic 이고, inode 를 통째로 갈아 끼우므로 이전 파일이 0644
    // 였어도 결과는 0600 이다.
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError(
      'credential_file_unreadable',
      `Cannot write the credentials file at ${file}: ${describeErrno(error)}`,
    );
  }

  const stats = await fs.stat(file);
  if (enforcesFileMode() && (stats.mode & 0o077) !== 0) {
    // WSL 의 DrvFs 나 exFAT 처럼 mode 를 무시하는 마운트에서 조용히 세계에 읽히는 파일을
    // 남기지 않는다.
    await fs.rm(file, { force: true });
    throw new CliError(
      'credential_file_mode',
      `The filesystem holding ${file} ignored the 0600 permission (it ended up ${formatMode(stats.mode)}), so the credentials were removed instead of being left readable by others. Point ARTEL_CONFIG_DIR at a filesystem that honours POSIX permissions.`,
    );
  }

  return { exists: true, mode: enforcesFileMode() ? formatMode(stats.mode) : null };
}

/** 파일이 없어도 실패하지 않는다. 지워진 것이 있으면 `true`. */
export async function removeCredential(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const file = credentialsPath(env);
  try {
    await fs.unlink(file);
    return true;
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) {
      return false;
    }
    throw new CliError(
      'credential_file_unreadable',
      `Cannot remove the credentials file at ${file}: ${describeErrno(error)}`,
    );
  }
}

/** `ssh` 가 private key 에 하는 것과 같은 판단이다. */
function assertNotGroupOrWorldAccessible(file: string, mode: number): void {
  if (!enforcesFileMode() || (mode & 0o077) === 0) {
    return;
  }
  throw new CliError(
    'credential_file_mode',
    `The credentials file at ${file} is ${formatMode(mode)}; it must not be readable by group or others. Run "chmod 600 ${file}" or "artel auth login" again.`,
  );
}

function parseStoredCredential(raw: string, file: string): StoredCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError(
      'credential_file_unreadable',
      `The credentials file at ${file} is not valid JSON. Run "artel auth login" again.`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CliError(
      'credential_file_unreadable',
      `The credentials file at ${file} is not a JSON object. Run "artel auth login" again.`,
    );
  }

  const fields = parsed as Partial<Record<keyof StoredCredential, unknown>>;

  if (typeof fields.version !== 'number') {
    throw new CliError(
      'credential_file_unreadable',
      `The credentials file at ${file} has no numeric "version" field. Run "artel auth login" again.`,
    );
  }
  if (fields.version !== CREDENTIAL_FILE_VERSION) {
    throw new CliError(
      'credential_file_version',
      `The credentials file at ${file} is version ${String(fields.version)}, but this CLI only reads version ${String(CREDENTIAL_FILE_VERSION)}. Upgrade the CLI or run "artel auth login" again.`,
    );
  }

  const token = requireString(fields.token, 'token', file);
  const tokenId = requireString(fields.tokenId, 'tokenId', file);
  const tokenName = requireString(fields.tokenName, 'tokenName', file);
  const createdAt = requireString(fields.createdAt, 'createdAt', file);
  const apiBaseUrl = requireString(fields.apiBaseUrl, 'apiBaseUrl', file);
  const expiresAt = fields.expiresAt;
  if (expiresAt !== null && typeof expiresAt !== 'string') {
    throw new CliError(
      'credential_file_unreadable',
      `The credentials file at ${file} has an "expiresAt" field that is neither a string nor null. Run "artel auth login" again.`,
    );
  }

  return {
    version: CREDENTIAL_FILE_VERSION,
    token,
    tokenId,
    tokenName,
    createdAt,
    expiresAt,
    apiBaseUrl,
  };
}

function requireString(value: unknown, field: string, file: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CliError(
      'credential_file_unreadable',
      `The credentials file at ${file} has no string "${field}" field. Run "artel auth login" again.`,
    );
  }
  return value;
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

function describeErrno(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
  ) {
    return (error as { code: string }).code;
  }
  return error instanceof Error ? error.message : 'unknown error';
}
