import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CliError } from '../../errors.js';
import type { ServerStartPayload } from '../../output/contract.js';
import { writeJsonPayload, type OutputSink } from '../../output/envelope.js';
import { readStackConfig } from '../../server/config-file.js';
import { ensureRuntime } from '../../server/install.js';
import { logFilePath, readLastLines } from '../../server/logs.js';
import { currentTarget, dataPaths } from '../../server/paths.js';
import {
  effectiveSettings,
  plainTextWarning,
  validateSettings,
} from '../../server/stack-settings.js';
import { isPidAlive, readState, SERVICE_NAMES } from '../../server/state-file.js';
import {
  DEFAULT_TIMEOUTS,
  stackStatus,
  startStackWithInternals,
  type SupervisorEvent,
  type SupervisorOptions,
} from '../../server/supervisor.js';
import {
  commandDataDir,
  downloadProgressReporter,
  withSupervisorErrors,
  type ServerDownloadDeps,
} from './shared.js';

export interface ServerStartOptions {
  json: boolean;
  foreground: boolean;
  /** `false` 면 runtime 이 없을 때 받지 않고 실패한다(`--no-install`). */
  install: boolean;
  host?: string | undefined;
  port?: number | undefined;
  publicUrl?: string | undefined;
  tlsCert?: string | undefined;
  tlsKey?: string | undefined;
}

/** 분리해 띄운 supervisor 가 준비될 때까지 기다리는 상한. 각 service 의 준비 상한을 더한 값이다. */
const DETACHED_READY_TIMEOUT_MS =
  DEFAULT_TIMEOUTS.postgresReadyMs +
  DEFAULT_TIMEOUTS.orchestrationReadyMs +
  DEFAULT_TIMEOUTS.agentServerReadyMs +
  60_000;

/** 분리한 supervisor 가 log 를 열기 전에 실패해도 이유가 남도록 stdout 과 stderr 를 받는 파일. */
const START_LOG = 'start.log';

const FIRST_SIGNUP_HINT =
  'On a fresh data directory, open the URL and sign up: the first account becomes the administrator, and later accounts are created by that administrator.';

function describeEvent(event: SupervisorEvent): string | null {
  if (event.type === 'service') {
    return `${event.service}: ${event.state}${event.detail ? ` (${event.detail})` : ''}`;
  }
  if (event.type === 'ready') return `ready: ${event.url}`;
  return null;
}

function supervisorOptions(options: ServerStartOptions, dataDir: string): SupervisorOptions {
  return {
    dataDir,
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.publicUrl === undefined ? {} : { publicUrl: options.publicUrl }),
    ...(options.tlsCert === undefined || options.tlsKey === undefined
      ? {}
      : { tls: { certFile: options.tlsCert, keyFile: options.tlsKey } }),
  };
}

/**
 * 분리하기 전에 이 terminal 에서 설정을 검증한다. 잘못된 TLS 파일이나 공개 주소가 start.log 속
 * 실패가 아니라 명령의 오류로 나온다. 돌려주는 값은 사용자에게 보일 경고다.
 */
async function checkSettings(options: ServerStartOptions, dataDir: string): Promise<string[]> {
  if ((options.tlsCert === undefined) !== (options.tlsKey === undefined)) {
    throw new CliError(
      'server_settings_invalid',
      '--tls-cert and --tls-key go together: give both files or neither.',
    );
  }
  const saved = await readStackConfig(dataPaths(dataDir).configFile);
  const settings = effectiveSettings(saved, supervisorOptions(options, dataDir));
  await withSupervisorErrors(() => validateSettings(settings));
  const warning = plainTextWarning(settings);
  return warning === null ? [] : [warning];
}

function report(sink: OutputSink, json: boolean, payload: ServerStartPayload): void {
  if (json) {
    writeJsonPayload(sink, payload);
    return;
  }
  sink.out(
    payload.attached
      ? `ARTEL is already running at ${payload.url}`
      : `ARTEL is running at ${payload.url}`,
  );
  for (const warning of payload.warnings) sink.err(`warning: ${warning}`);
  if (!payload.attached) sink.out(FIRST_SIGNUP_HINT);
  sink.out('Stop it with "artel server stop".');
}

/**
 * terminal 에 붙어 돈다. Ctrl-C 나 SIGTERM 을 받으면 stack 을 순서대로 멈추고 끝난다. 분리해
 * 띄운 supervisor 도 이 경로로 돈다.
 */
async function runForeground(
  options: ServerStartOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv,
  dataDir: string,
  installed: boolean,
  warnings: string[],
): Promise<void> {
  const stack = await withSupervisorErrors(() =>
    startStackWithInternals(
      {
        ...supervisorOptions(options, dataDir),
        onEvent: (event) => {
          const line = describeEvent(event);
          if (line !== null) sink.err(line);
        },
      },
      { env },
    ),
  );
  const status = await stackStatus({ dataDir }, env);
  report(sink, options.json, {
    url: stack.url,
    attached: stack.attached,
    pid: status.pid ?? null,
    dataDir,
    installed,
    warnings: stack.attached ? [] : warnings,
  });
  if (stack.attached) return;

  const stopOnSignal = (): void => {
    sink.err('stopping...');
    void stack.stop();
  };
  process.once('SIGINT', stopOnSignal);
  process.once('SIGTERM', stopOnSignal);
  try {
    await stack.closed;
  } finally {
    process.off('SIGINT', stopOnSignal);
    process.off('SIGTERM', stopOnSignal);
  }
}

function cliEntry(): string {
  // `dist/commands/server/start.js` 에서 `dist/cli.js` 로 간다.
  return fileURLToPath(new URL('../../cli.js', import.meta.url));
}

function detachedArgs(options: ServerStartOptions): string[] {
  // runtime 은 이 명령이 이미 받아 두었다. 분리한 supervisor 가 다시 받지 않게 한다.
  const args = [cliEntry(), 'server', 'start', '--foreground', '--no-install'];
  if (options.host !== undefined) args.push('--host', options.host);
  if (options.port !== undefined) args.push('--port', String(options.port));
  if (options.publicUrl !== undefined) args.push('--public-url', options.publicUrl);
  if (options.tlsCert !== undefined) args.push('--tls-cert', options.tlsCert);
  if (options.tlsKey !== undefined) args.push('--tls-key', options.tlsKey);
  return args;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function failureDetail(logs: string): string {
  const lines = [
    ...readLastLines(`${logs}/${START_LOG}`, 5),
    ...readLastLines(logFilePath(logs, 'supervisor'), 3),
  ].filter((line) => line.trim().length > 0);
  return lines.length > 0 ? `\n${lines.join('\n')}` : '';
}

/**
 * supervisor 를 분리한 process 로 띄우고, 모든 service 가 `ready` 가 될 때까지 기다린다.
 * Electron 의 `ELECTRON_RUN_AS_NODE` 도 env 를 그대로 넘기므로 같은 실행 파일로 다시 돈다.
 */
async function runDetached(
  options: ServerStartOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv,
  dataDir: string,
  installed: boolean,
  warnings: string[],
): Promise<void> {
  const paths = dataPaths(dataDir);
  fs.mkdirSync(paths.logs, { recursive: true });
  const startLog = fs.openSync(`${paths.logs}/${START_LOG}`, 'w');
  const child = spawn(process.execPath, detachedArgs(options), {
    detached: true,
    stdio: ['ignore', startLog, startLog],
    env,
    windowsHide: true,
  });
  fs.closeSync(startLog);
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });
  child.once('error', () => {
    exited = true;
  });
  child.unref();
  sink.err(`Starting ARTEL (supervisor pid ${String(child.pid ?? '?')}); logs in ${paths.logs}`);

  const deadline = Date.now() + DETACHED_READY_TIMEOUT_MS;
  let lastReported = '';
  while (Date.now() < deadline) {
    const state = await readState(paths.stateFile);
    if (state !== null && isPidAlive(state.supervisorPid)) {
      const progress = SERVICE_NAMES.map((name) => `${name} ${state.services[name]}`).join(', ');
      if (progress !== lastReported) {
        sink.err(progress);
        lastReported = progress;
      }
      if (SERVICE_NAMES.every((name) => state.services[name] === 'ready')) {
        report(sink, options.json, {
          url: state.url,
          attached: state.supervisorPid !== child.pid,
          pid: state.supervisorPid,
          dataDir,
          installed,
          warnings: state.supervisorPid !== child.pid ? [] : warnings,
        });
        return;
      }
    }
    if (exited || (child.pid !== undefined && !isPidAlive(child.pid))) {
      throw new CliError(
        'server_start_failed',
        `The ARTEL supervisor exited before the stack was ready. See ${paths.logs}.${failureDetail(paths.logs)}`,
      );
    }
    await sleep(500);
  }
  throw new CliError(
    'server_start_failed',
    `The ARTEL stack was not ready within ${String(Math.round(DETACHED_READY_TIMEOUT_MS / 1000))} seconds. It may still be starting; check "artel server status" and ${paths.logs}.`,
  );
}

/**
 * 기본 위치에 runtime 이 없으면 받는다. 분리한 supervisor 를 띄우기 전에 이 terminal 에서 받으므로
 * 진행 상황이 보이고, 받기에 실패하면 아무 process 도 띄우지 않는다.
 */
async function installIfMissing(
  options: ServerStartOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv,
  dataDir: string,
  deps: ServerDownloadDeps,
): Promise<boolean> {
  const target = currentTarget();
  // 지원하지 않는 기계는 supervisor 가 `server_unsupported_platform` 으로 거절한다.
  if (target === null) return false;
  const progress = options.json ? undefined : downloadProgressReporter(sink);
  try {
    const result = await withSupervisorErrors(() =>
      ensureRuntime({
        dataDir,
        env,
        allowInstall: options.install,
        target,
        ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
        ...(deps.baseUrl === undefined ? {} : { baseUrl: deps.baseUrl }),
        ...(progress === undefined
          ? {}
          : { onProgress: progress.message, onDownloadProgress: progress.bytes }),
      }),
    );
    return result.installed;
  } finally {
    progress?.done();
  }
}

export async function runServerStart(
  options: ServerStartOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
  deps: ServerDownloadDeps = {},
): Promise<void> {
  const dataDir = commandDataDir(env);
  const before = await stackStatus({ dataDir }, env);
  if (before.running && before.url !== undefined) {
    report(sink, options.json, {
      url: before.url,
      attached: true,
      pid: before.pid ?? null,
      dataDir,
      installed: false,
      warnings: [],
    });
    return;
  }

  const warnings = await checkSettings(options, dataDir);
  const installed = await installIfMissing(options, sink, env, dataDir, deps);
  if (options.foreground) {
    await runForeground(options, sink, env, dataDir, installed, warnings);
    return;
  }
  await runDetached(options, sink, env, dataDir, installed, warnings);
}
