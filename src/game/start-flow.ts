import fs from 'node:fs/promises';
import path from 'node:path';

import { CliError } from '../errors.js';
import { mintSdkToken, type FetchLike } from '../http/client.js';
import { listGameInstances, type GameInstance } from '../http/gameInstances.js';
import { buildGameLaunchArgs, deriveGameServerAddress } from './launch-args.js';
import { generateGameLogPath } from './log-file.js';
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
  };
}

export interface GameStartResult {
  instance: GameInstance;
  pid: number | null;
  logFilePath: string;
  serverAddress: string;
  secure: boolean;
}

export async function runGameStartFlow(
  options: GameStartOptions,
  deps: GameStartDeps,
): Promise<GameStartResult> {
  const { serverAddress, secure } = deriveGameServerAddress(options.apiBaseUrl);
  const logFilePath = deps.generateLogPath();
  await fs.mkdir(path.dirname(logFilePath), { recursive: true });

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
    logFilePath,
    width: options.width,
    height: options.height,
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
        `${options.build} exited (code ${String(info.code)}, signal ${info.signal ?? 'none'}) before it registered with project ${options.projectId}. Check the game log at ${logFilePath}.`,
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
      return { instance: registered, pid: child.pid, logFilePath, serverAddress, secure };
    }

    if (Date.now() >= deadline) {
      throw new CliError(
        'game_registration_timeout',
        `${options.build} did not register with project ${options.projectId} within ${String(Math.round(options.registrationTimeoutMs / 1000))} seconds. Check the game log at ${logFilePath}.`,
      );
    }
    await deps.sleep(deps.pollIntervalMs);
  }
}
