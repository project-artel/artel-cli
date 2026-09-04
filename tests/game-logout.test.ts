import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runGameLogout } from '../src/commands/game/logout.js';
import type { CliError } from '../src/errors.js';
import { runGameLogoutFlow, type GameLogoutDeps } from '../src/game/logout-flow.js';
import type { GameLogoutPayload } from '../src/output/contract.js';
import {
  createFakeSpawner,
  createMemorySink,
  createTempConfig,
  startFakeGameServer,
  waitUntil,
  type FakeSpawner,
  type MemorySink,
  type TempConfig,
} from './helpers.js';

const SDK_TOKEN = 'artel_sdk_token_that_must_never_be_in_argv';
const CONSOLE_BASE_URL = 'https://console.example.test';

let temp: TempConfig;
let spawner: FakeSpawner;

beforeEach(async () => {
  temp = await createTempConfig();
  spawner = createFakeSpawner();
});

afterEach(async () => {
  await temp.cleanup();
});

function deps(overrides: Partial<GameLogoutDeps> = {}): GameLogoutDeps {
  return {
    spawn: spawner.spawn,
    fetchImpl: globalThis.fetch,
    notify: () => undefined,
    generateLogPath: () => `${temp.root}/game-logout.log`,
    ...overrides,
  };
}

describe('runGameLogoutFlow', () => {
  it('launches the build with -artel-logout and reports the exit code once it exits', async () => {
    const api = await startFakeGameServer({ sdkToken: SDK_TOKEN, instanceSequence: [[]] });
    try {
      const promise = runGameLogoutFlow(
        {
          apiBaseUrl: api.baseUrl,
          consoleBaseUrl: CONSOLE_BASE_URL,
          cliToken: 'artel_cli_token',
          build: '/games/my-game',
          projectId: '42',
          width: 1280,
          height: 720,
          logoutTimeoutMs: 2_000,
          processEnv: { PATH: '/usr/bin' },
        },
        deps(),
      );

      await waitUntil(() => spawner.processes.length > 0);
      spawner.processes[0]?.fireExit(0, null);

      const result = await promise;
      expect(result.exitCode).toBe(0);
      expect(spawner.calls[0]?.args).toContain('-artel-logout');
      // 지우러 가는 실행은 토큰도 프로젝트도 들고 가지 않는다. SDK 는 지우고 나서 심으므로
      // 둘 중 하나라도 실으면 로그아웃이 그 자리에서 로그인으로 뒤집힌다.
      expect(spawner.calls[0]?.env.ARTEL_SDK_TOKEN).toBeUndefined();
      expect(spawner.calls[0]?.args).not.toContain('-artel-project');
      expect(spawner.calls[0]?.args.join(' ')).not.toContain(SDK_TOKEN);
      // 지우러 가는 실행이다. `game start` 와 달리 `--window-label` 이 없어, 이 실행은 무엇을
      // 위해 띄운 것인지 창에 남기지 않는다.
      expect(spawner.calls[0]?.args).not.toContain('-artel-window-label');
    } finally {
      await api.close();
    }
  });

  it('kills the child and fails with game_logout_timeout if it never exits', async () => {
    const api = await startFakeGameServer({ sdkToken: SDK_TOKEN, instanceSequence: [[]] });
    try {
      const failure = (await runGameLogoutFlow(
        {
          apiBaseUrl: api.baseUrl,
          consoleBaseUrl: CONSOLE_BASE_URL,
          cliToken: 'artel_cli_token',
          build: '/games/my-game',
          projectId: '42',
          width: 1280,
          height: 720,
          logoutTimeoutMs: 20,
          processEnv: {},
        },
        deps(),
      ).catch((error: unknown) => error)) as CliError;

      expect(failure.code).toBe('game_logout_timeout');
      expect(failure.message).toContain(`${temp.root}/game-logout.log`);
      expect(spawner.processes[0]?.killCalls).toEqual(['SIGTERM']);
    } finally {
      await api.close();
    }
  });
});

describe('artel game logout (command layer)', () => {
  it('emits exactly its contracted --json keys and explains why it launches the build', async () => {
    const api = await startFakeGameServer({ sdkToken: SDK_TOKEN, instanceSequence: [[]] });
    try {
      const sink: MemorySink = createMemorySink();
      const promise = runGameLogout(
        {
          json: true,
          project: '42',
          build: '/games/my-game',
          width: 1280,
          height: 720,
          timeoutSeconds: 5,
        },
        sink,
        {
          ARTEL_CONFIG_DIR: temp.configDir,
          ARTEL_API_BASE_URL: api.baseUrl,
          ARTEL_CONSOLE_BASE_URL: CONSOLE_BASE_URL,
          ARTEL_TOKEN: 'artel_cli_token',
        },
        () => deps(),
      );

      await waitUntil(() => spawner.processes.length > 0);
      spawner.processes[0]?.fireExit(0, null);
      await promise;

      const payload = sink.lastJson<GameLogoutPayload>();
      expect(Object.keys(payload).sort()).toEqual(
        [
          'build',
          'exitCode',
          'frontendUrl',
          'logFilePath',
          'pid',
          'projectId',
          'secure',
          'serverAddress',
          'signal',
        ].sort(),
      );
      expect(payload.exitCode).toBe(0);
    } finally {
      await api.close();
    }
  });

  it('says in human output that only the game process can clear the session', async () => {
    const api = await startFakeGameServer({ sdkToken: SDK_TOKEN, instanceSequence: [[]] });
    try {
      const sink: MemorySink = createMemorySink();
      const promise = runGameLogout(
        {
          json: false,
          project: '42',
          build: '/games/my-game',
          width: 1280,
          height: 720,
          timeoutSeconds: 5,
        },
        sink,
        {
          ARTEL_CONFIG_DIR: temp.configDir,
          ARTEL_API_BASE_URL: api.baseUrl,
          ARTEL_CONSOLE_BASE_URL: CONSOLE_BASE_URL,
          ARTEL_TOKEN: 'artel_cli_token',
        },
        () => deps(),
      );

      await waitUntil(() => spawner.processes.length > 0);
      spawner.processes[0]?.fireExit(0, null);
      await promise;

      expect(sink.everything()).toContain('platform secret store');
      expect(sink.everything()).toContain('only the game process');
    } finally {
      await api.close();
    }
  });
});
