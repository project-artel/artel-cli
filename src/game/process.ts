import { spawn } from 'node:child_process';

import { CliError } from '../errors.js';

export interface SpawnedGameProcess {
  readonly pid: number | null;
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  kill(signal?: NodeJS.Signals): void;
}

/**
 * `auth/login-flow.ts` 가 `openBrowser` 를 주입받는 것과 같은 손잡이다. 실제 게임을
 * 띄우지 않고 `game start`/`game logout` 을 테스트하는 유일한 지점이다.
 */
export type GameProcessSpawner = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => Promise<SpawnedGameProcess>;

/**
 * `detached: true` 로 띄운다 — `game start` 는 등록을 확인하면 그대로 끝나야 하고, 게임은
 * 그 뒤로도 계속 떠 있어야 나중의 QA 명령이 다룰 수 있다. `unref` 는 spawn 이 성공한 직후
 * 바로 건다: 그래야 이어지는 등록 대기(폴링 타이머가 이벤트 루프를 붙잡는다)와 무관하게,
 * 부모 CLI 프로세스가 끝날 때 이 자식 때문에 멈춰 서지 않는다.
 *
 * `stdio: 'ignore'` — 게임의 표준 출력은 버린다. 로그는 `-logFile` 로 파일에 남기고, 부모
 * CLI 의 표준 출력에는 `--json` payload 한 줄만 남아야 한다.
 */
export const spawnGameProcess: GameProcessSpawner = async (command, args, env) => {
  const child = spawn(command, [...args], { detached: true, stdio: 'ignore', env });

  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', () => {
      resolve();
    });
  });
  child.unref();

  return {
    pid: child.pid ?? null,
    onExit(listener) {
      child.on('exit', listener);
    },
    kill(signal) {
      child.kill(signal);
    },
  };
};

export function isEnoentError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

/**
 * `game/start-flow.ts` 와 `game/logout-flow.ts` 가 함께 쓴다. spawn 실패를 두 error code 로
 * 나눈다 — 경로가 없거나 실행 권한이 없는 흔한 실수(`game_build_not_found`)와 그 밖의
 * 실패(`game_launch_failed`)를 구분해야 사용자가 무엇을 고칠지 알 수 있다.
 */
export async function spawnGame(
  spawn: GameProcessSpawner,
  build: string,
  args: readonly string[],
  processEnv: NodeJS.ProcessEnv,
  sdkToken: string,
): Promise<SpawnedGameProcess> {
  try {
    return await spawn(build, args, { ...processEnv, ARTEL_SDK_TOKEN: sdkToken });
  } catch (error) {
    if (isEnoentError(error)) {
      throw new CliError(
        'game_build_not_found',
        `Could not launch the build at ${build}: no such file, or it is not executable.`,
      );
    }
    throw new CliError(
      'game_launch_failed',
      `Could not launch the build at ${build}: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
}
