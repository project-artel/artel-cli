import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { StackConfig } from './config-file.js';
import { SupervisorError } from './errors.js';
import { logFilePath } from './logs.js';
import type { RuntimeLayout } from './manifest.js';
import type { DataPaths } from './paths.js';
import { runToCompletion } from './process.js';
import { postgresSettings } from './services.js';

export const DATABASE_NAME = 'artel';
export const DATABASE_USER = 'artel';

/** `postgresql.conf` 끝에 붙여 supervisor 가 쓰는 설정 파일을 읽게 한다. */
const SETTINGS_FILE = 'artel.conf';
const INCLUDE_LINE = `include_if_exists = '${SETTINGS_FILE}'`;
/** `createdb` 가 끝났다는 표시. initdb 뒤 createdb 전에 죽었어도 다음 start 가 마저 한다. */
const DATABASE_MARKER = 'artel.database-created';

export interface PostgresContext {
  runtime: RuntimeLayout;
  paths: DataPaths;
  config: StackConfig;
  onLine: (line: string) => void;
}

/**
 * bundle 의 PostgreSQL 이 자기 `lib/` 을 찾도록 library 경로를 앞에 붙인다. rpath 로 build 했으면
 * 해가 없고, 아니면 이것 없이는 `libpq` 를 못 찾는다.
 */
export function postgresEnv(context: PostgresContext): NodeJS.ProcessEnv {
  const libDir = path.join(path.dirname(path.dirname(context.runtime.executables.pg_ctl)), 'lib');
  const env: NodeJS.ProcessEnv = { ...process.env, PGPASSWORD: context.config.dbPassword };
  const variable =
    process.platform === 'darwin'
      ? 'DYLD_LIBRARY_PATH'
      : process.platform === 'win32'
        ? null
        : 'LD_LIBRARY_PATH';
  if (variable !== null) {
    const current = env[variable];
    env[variable] = current ? `${libDir}${path.delimiter}${current}` : libDir;
  }
  return env;
}

/**
 * unix socket 경로는 OS 마다 103~107 byte 가 상한이다. 데이터 디렉터리가 깊으면 그 안에 둘 수
 * 없으므로 임시 디렉터리 아래 사용자별 디렉터리로 옮긴다. Windows 는 TCP 만 쓴다.
 */
export function socketDirFor(paths: DataPaths, port: number): string | null {
  if (process.platform === 'win32') return null;
  const socketFile = path.join(paths.socketDir, `.s.PGSQL.${String(port)}`);
  if (Buffer.byteLength(socketFile) <= 100) return paths.socketDir;
  const uid = process.getuid?.() ?? 0;
  return path.join(os.tmpdir(), `artel-pg-${String(uid)}`);
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function startFailure(context: PostgresContext, step: string, output: string): SupervisorError {
  const toolLog = logFilePath(context.paths.logs, 'postgres');
  const serverLog = logFilePath(context.paths.logs, 'postgres-server');
  const detail = output.trim() ? ` Output: ${output.trim().split('\n').slice(-5).join(' | ')}` : '';
  return new SupervisorError(
    'server_start_failed',
    `PostgreSQL ${step} failed. See ${toolLog} and ${serverLog}.${detail}`,
  );
}

/** `pgdata/` 이 없으면 initdb 로 만든다. 만들었으면 `true`. */
export async function ensureCluster(context: PostgresContext): Promise<boolean> {
  const { paths, runtime, config } = context;
  if (await exists(path.join(paths.pgdata, 'PG_VERSION'))) return false;

  await fs.rm(paths.pgdata, { recursive: true, force: true });
  await fs.mkdir(paths.dataDir, { recursive: true });
  const passwordFile = path.join(paths.dataDir, `initdb-password.${String(process.pid)}.tmp`);
  await fs.writeFile(passwordFile, `${config.dbPassword}\n`, { mode: 0o600 });
  try {
    const result = await runToCompletion(
      runtime.executables.initdb,
      [
        '-U',
        DATABASE_USER,
        '--auth=scram-sha-256',
        `--pwfile=${passwordFile}`,
        '-E',
        'UTF8',
        '--locale=C',
        '-D',
        paths.pgdata,
      ],
      { env: postgresEnv(context), onLine: context.onLine },
    );
    if (result.code !== 0) {
      await fs.rm(paths.pgdata, { recursive: true, force: true });
      throw startFailure(context, 'initdb', result.output);
    }
  } finally {
    await fs.rm(passwordFile, { force: true });
  }

  const confFile = path.join(paths.pgdata, 'postgresql.conf');
  const conf = await fs.readFile(confFile, 'utf8').catch(() => '');
  if (!conf.includes(INCLUDE_LINE)) {
    await fs.appendFile(confFile, `\n${INCLUDE_LINE}\n`);
  }
  return true;
}

/** port 가 start 마다 바뀔 수 있어 설정 파일은 매번 다시 쓴다. */
export async function writeSettings(context: PostgresContext): Promise<void> {
  const socketDir = socketDirFor(context.paths, context.config.ports.postgres);
  if (socketDir !== null) await fs.mkdir(socketDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(context.paths.pgdata, SETTINGS_FILE),
    postgresSettings({ port: context.config.ports.postgres, socketDir }),
  );
}

export async function startPostgres(context: PostgresContext): Promise<void> {
  const result = await runToCompletion(
    context.runtime.executables.pg_ctl,
    [
      'start',
      '-D',
      context.paths.pgdata,
      '-l',
      logFilePath(context.paths.logs, 'postgres-server'),
      '-w',
      '-t',
      '120',
    ],
    { env: postgresEnv(context), onLine: context.onLine },
  );
  if (result.code !== 0) throw startFailure(context, 'pg_ctl start', result.output);
}

export async function isPostgresReady(context: PostgresContext): Promise<boolean> {
  const result = await runToCompletion(
    context.runtime.executables.pg_isready,
    [
      '-h',
      '127.0.0.1',
      '-p',
      String(context.config.ports.postgres),
      '-U',
      DATABASE_USER,
      '-d',
      'postgres',
    ],
    { env: postgresEnv(context) },
  );
  return result.code === 0;
}

/** 첫 start 에서 `artel` database 를 만든다. 이미 있다는 실패는 성공으로 본다. */
export async function ensureDatabase(context: PostgresContext): Promise<void> {
  const marker = path.join(context.paths.pgdata, DATABASE_MARKER);
  if (await exists(marker)) return;
  const result = await runToCompletion(
    context.runtime.executables.createdb,
    [
      '-h',
      '127.0.0.1',
      '-p',
      String(context.config.ports.postgres),
      '-U',
      DATABASE_USER,
      DATABASE_NAME,
    ],
    { env: postgresEnv(context), onLine: context.onLine },
  );
  if (result.code !== 0 && !/already exists/i.test(result.output)) {
    throw startFailure(context, 'createdb', result.output);
  }
  await fs.writeFile(marker, `${new Date().toISOString()}\n`);
}

/** `postmaster.pid` 의 첫 줄. postmaster 가 떠 있지 않으면 `null`. */
export async function postmasterPid(pgdata: string): Promise<number | null> {
  try {
    const first = (await fs.readFile(path.join(pgdata, 'postmaster.pid'), 'utf8')).split('\n')[0];
    const pid = Number.parseInt(first ?? '', 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export async function stopPostgres(
  pgCtl: string,
  pgdata: string,
  env: NodeJS.ProcessEnv,
  onLine?: (line: string) => void,
): Promise<boolean> {
  if ((await postmasterPid(pgdata)) === null) return true;
  const result = await runToCompletion(
    pgCtl,
    ['stop', '-D', pgdata, '-m', 'fast', '-w', '-t', '60'],
    { env, ...(onLine === undefined ? {} : { onLine }) },
  );
  return result.code === 0;
}
