import fs from 'node:fs/promises';
import path from 'node:path';

import { CliError } from '../errors.js';
import { mintSdkToken, type FetchLike } from '../http/client.js';
import { listGameInstances, type GameInstance } from '../http/gameInstances.js';
import { buildGameLaunchArgs, deriveGameServerAddress } from './launch-args.js';
import {
  generateGameLogPath,
  inspectGameLogFile,
  resolveLaunchLogPath,
  type GameLogFileStatus,
  type LaunchLogPathResolver,
} from './log-file.js';
import { spawnGame, spawnGameProcess, type GameProcessSpawner } from './process.js';
import { findNewlyRegisteredInstance } from './registration.js';

export const DEFAULT_REGISTRATION_TIMEOUT_MS = 60_000;
export const DEFAULT_POLL_INTERVAL_MS = 1_000;

export interface GameStartOptions {
  apiBaseUrl: string;
  consoleBaseUrl: string;
  cliToken: string;
  build: string;
  projectId: string;
  width: number;
  height: number;
  /** 기본은 창 모드다. 이유는 `game/launch-args.ts` 의 `fullscreen` 에 적혀 있다. */
  fullscreen: boolean;
  registrationTimeoutMs: number;
  /** 자식에 물려줄 바탕 환경 — 실제 실행에서는 `process.env` 다. `ARTEL_SDK_TOKEN` 은 이 flow 가 여기 더한다. */
  processEnv: NodeJS.ProcessEnv;
}

export interface GameStartDeps {
  spawn: GameProcessSpawner;
  fetchImpl: FetchLike;
  notify: (message: string) => void;
  sleep: (ms: number) => Promise<void>;
  pollIntervalMs: number;
  generateLogPath: () => string;
  /** 없으면 경로를 그대로 넘긴다. WSL 에서 `.exe` 를 띄울 때의 변환은 [resolveLaunchLogPath] 다. */
  launchLogPath?: LaunchLogPathResolver;
}

export function defaultGameStartDeps(
  notify: (message: string) => void,
  env: NodeJS.ProcessEnv = process.env,
): GameStartDeps {
  return {
    spawn: spawnGameProcess,
    fetchImpl: globalThis.fetch,
    notify,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    generateLogPath: () => generateGameLogPath(env),
    launchLogPath: resolveLaunchLogPath,
  };
}

export interface GameStartResult extends GameLogFileStatus {
  instance: GameInstance;
  pid: number | null;
  serverAddress: string;
  secure: boolean;
}

export async function runGameStartFlow(
  options: GameStartOptions,
  deps: GameStartDeps,
): Promise<GameStartResult> {
  const { serverAddress, secure } = deriveGameServerAddress(options.apiBaseUrl);
  const logFilePath = deps.generateLogPath();
  // 디렉터리를 못 만들어도 실행은 막지 않는다. 로그가 없는 것이 게임을 못 띄우는 이유는 아니고,
  // 없다는 사실과 이유는 결과에 `logFilePath: null` 로 남긴다.
  let directoryError: string | null = null;
  try {
    await fs.mkdir(path.dirname(logFilePath), { recursive: true });
  } catch (error) {
    directoryError = error instanceof Error ? error.message : 'unknown error';
  }
  const launchLogPath = await (deps.launchLogPath ?? ((logPath) => Promise.resolve(logPath)))(
    logFilePath,
    options.build,
  );

  deps.notify('Requesting an SDK token…');
  const minted = await mintSdkToken(options.apiBaseUrl, options.cliToken, deps.fetchImpl);

  deps.notify(`Checking which game instances project ${options.projectId} already has…`);
  const before = await listGameInstances(
    options.apiBaseUrl,
    options.cliToken,
    options.projectId,
    deps.fetchImpl,
  );

  const args = buildGameLaunchArgs({
    serverAddress,
    secure,
    frontendUrl: options.consoleBaseUrl,
    projectId: options.projectId,
    logFilePath: launchLogPath,
    width: options.width,
    height: options.height,
    fullscreen: options.fullscreen,
    logout: false,
  });

  deps.notify(`Launching ${options.build}…`);
  const child = await spawnGame(deps.spawn, options.build, args, options.processEnv, minted.token);

  let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  child.onExit((code, signal) => {
    exitInfo = { code, signal };
  });

  deps.notify('Waiting for the game to register with the server…');
  const deadline = Date.now() + options.registrationTimeoutMs;
  for (;;) {
    if (exitInfo !== null) {
      const info: { code: number | null; signal: NodeJS.Signals | null } = exitInfo;
      throw new CliError(
        'game_exited_before_registration',
        `${options.build} exited (code ${String(info.code)}, signal ${info.signal ?? 'none'}) before it registered with project ${options.projectId}. ${await describeLogHint(logFilePath, launchLogPath, directoryError)}`,
      );
    }

    const after = await listGameInstances(
      options.apiBaseUrl,
      options.cliToken,
      options.projectId,
      deps.fetchImpl,
    );
    const registered = findNewlyRegisteredInstance(before, after);
    if (registered !== null) {
      // 등록 시점이면 Unity 는 로그 파일을 이미 열었다. 그때도 없으면 `-logFile` 이 먹지 않은 것이다.
      return {
        instance: registered,
        pid: child.pid,
        ...(await inspectGameLogFile(logFilePath, launchLogPath, directoryError)),
        serverAddress,
        secure,
      };
    }

    if (Date.now() >= deadline) {
      throw new CliError(
        'game_registration_timeout',
        `${options.build} did not register with project ${options.projectId} within ${String(Math.round(options.registrationTimeoutMs / 1000))} seconds. ${await describeLogHint(logFilePath, launchLogPath, directoryError)}`,
      );
    }
    await deps.sleep(deps.pollIntervalMs);
  }
}

async function describeLogHint(
  logFilePath: string,
  launchLogPath: string,
  directoryError: string | null,
): Promise<string> {
  const status = await inspectGameLogFile(logFilePath, launchLogPath, directoryError);
  return status.logFilePath === null
    ? `No game log was written. ${status.logFileUnavailableReason ?? ''}`
    : `Check the game log at ${status.logFilePath}.`;
}
