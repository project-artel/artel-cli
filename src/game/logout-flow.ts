import fs from 'node:fs/promises';
import path from 'node:path';

import { CliError } from '../errors.js';
import { mintSdkToken, type FetchLike } from '../http/client.js';
import { buildGameLaunchArgs, deriveGameServerAddress } from './launch-args.js';
import { generateGameLogPath } from './log-file.js';
import {
  spawnGame,
  spawnGameProcess,
  type GameProcessSpawner,
  type SpawnedGameProcess,
} from './process.js';

export const DEFAULT_LOGOUT_TIMEOUT_MS = 30_000;

export interface GameLogoutOptions {
  apiBaseUrl: string;
  consoleBaseUrl: string;
  cliToken: string;
  build: string;
  projectId: string;
  width: number;
  height: number;
  logoutTimeoutMs: number;
  processEnv: NodeJS.ProcessEnv;
}

export interface GameLogoutDeps {
  spawn: GameProcessSpawner;
  fetchImpl: FetchLike;
  notify: (message: string) => void;
  generateLogPath: () => string;
}

export function defaultGameLogoutDeps(
  notify: (message: string) => void,
  env: NodeJS.ProcessEnv = process.env,
): GameLogoutDeps {
  return {
    spawn: spawnGameProcess,
    fetchImpl: globalThis.fetch,
    notify,
    generateLogPath: () => generateGameLogPath(env),
  };
}

export interface GameLogoutResult {
  pid: number | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  logFilePath: string;
  serverAddress: string;
  secure: boolean;
}

/**
 * 세션은 게임 자신의 platform secret store 에 있다 — CLI 가 지울 파일이 아니다. 그래서
 * `-artel-logout` 을 들려 build 를 잠깐 띄우고, 그 실행이 스스로 지운 뒤 끝나기를 기다리는
 * 것 말고는 CLI 가 할 수 있는 일이 없다.
 */
export async function runGameLogoutFlow(
  options: GameLogoutOptions,
  deps: GameLogoutDeps,
): Promise<GameLogoutResult> {
  const { serverAddress, secure } = deriveGameServerAddress(options.apiBaseUrl);
  const logFilePath = deps.generateLogPath();
  await fs.mkdir(path.dirname(logFilePath), { recursive: true });

  deps.notify('Requesting an SDK token…');
  const minted = await mintSdkToken(options.apiBaseUrl, options.cliToken, deps.fetchImpl);

  const args = buildGameLaunchArgs({
    serverAddress,
    secure,
    frontendUrl: options.consoleBaseUrl,
    projectId: options.projectId,
    logFilePath,
    width: options.width,
    height: options.height,
    logout: true,
  });

  deps.notify(`Launching ${options.build} briefly to clear its stored session…`);
  const child = await spawnGame(deps.spawn, options.build, args, options.processEnv, minted.token);

  const exit = await waitForExit(child, options.logoutTimeoutMs);
  if (exit === null) {
    child.kill('SIGTERM');
    throw new CliError(
      'game_logout_timeout',
      `${options.build} did not exit within ${String(Math.round(options.logoutTimeoutMs / 1000))} seconds after being launched with -artel-logout. Check the game log at ${logFilePath}.`,
    );
  }

  return {
    pid: child.pid,
    exitCode: exit.code,
    signal: exit.signal,
    logFilePath,
    serverAddress,
    secure,
  };
}

function waitForExit(
  child: SpawnedGameProcess,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null } | null> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, timeoutMs);

    child.onExit((code, signal) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ code, signal });
      }
    });
  });
}
