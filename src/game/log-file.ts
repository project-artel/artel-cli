import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { credentialsDir } from '../credentials/paths.js';

/** `~/.artel/logs`(또는 `ARTEL_CONFIG_DIR` 아래 `logs`). credentials 파일과 같은 뿌리를 쓴다. */
export function gameLogDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(credentialsDir(env), 'logs');
}

/**
 * launch 한 번마다 새 파일 하나. Unity 의 `-logFile` 인자로 넘겨 그 실행이 어디에 로그를
 * 남기는지 CLI 가 미리 알게 한다 — 등록이 타임아웃되거나 게임이 일찍 죽었을 때 "어디를
 * 보면 되는지" 를 말할 수 있는 것은 이 값을 CLI 가 직접 정했기 때문이다.
 */
export function generateGameLogPath(env: NodeJS.ProcessEnv = process.env): string {
  const name = `game-${String(Date.now())}-${crypto.randomBytes(6).toString('hex')}.log`;
  return path.join(gameLogDir(env), name);
}

/**
 * Unity 에 `-logFile` 로 넘길 경로. WSL 에서 `.exe` 를 띄울 때는 Windows 경로여야 한다.
 *
 * 리눅스 경로(`/home/me/.artel/logs/game-1.log`)를 그대로 주면 Windows 프로세스는 그것을 현재
 * 드라이브의 `\home\me\...` 로 읽는다. 그 디렉터리가 없으면 파일이 만들어지지 않고, 있어도
 * CLI 가 보고한 경로와 다른 곳에 생긴다(ARTEL-1240). `wslpath -w` 가 같은 파일을 가리키는
 * `\\wsl.localhost\...` 경로를 돌려주므로 그것을 넘기고, 보고하는 경로는 리눅스 경로 그대로 둔다.
 */
export type LaunchLogPathResolver = (logFilePath: string, build: string) => Promise<string>;

export const resolveLaunchLogPath: LaunchLogPathResolver = async (logFilePath, build) => {
  if (process.platform !== 'linux' || !build.toLowerCase().endsWith('.exe')) {
    return logFilePath;
  }
  return await new Promise<string>((resolve) => {
    execFile('wslpath', ['-w', logFilePath], (error, stdout) => {
      const converted = stdout.trim();
      // wslpath 가 없으면(WSL 이 아닌 리눅스에서 wine 등으로 띄우는 경우) 원래 경로를 그대로 쓴다.
      resolve(error === null && converted.length > 0 ? converted : logFilePath);
    });
  });
};

/** `-logFile` 로 넘긴 파일이 실제로 있는지. 없으면 사용자에게 보일 이유를 돌려준다. */
export interface GameLogFileStatus {
  logFilePath: string | null;
  logFileUnavailableReason: string | null;
}

export async function inspectGameLogFile(
  logFilePath: string,
  launchLogPath: string,
  directoryError: string | null,
): Promise<GameLogFileStatus> {
  if (directoryError !== null) {
    return {
      logFilePath: null,
      logFileUnavailableReason: `Could not create the log directory for ${logFilePath}: ${directoryError}`,
    };
  }
  try {
    await fs.stat(logFilePath);
    return { logFilePath, logFileUnavailableReason: null };
  } catch {
    const passed = launchLogPath === logFilePath ? '' : ` (passed to the game as ${launchLogPath})`;
    return {
      logFilePath: null,
      logFileUnavailableReason: `The game was started with -logFile ${logFilePath}${passed}, but no file exists there. The game may not have been able to write to that location.`,
    };
  }
}
