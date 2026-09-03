import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runGameStart } from '../src/commands/game/start.js';
import type { CliError } from '../src/errors.js';
import type { GameInstance } from '../src/http/gameInstances.js';
import { runGameStartFlow, type GameStartDeps } from '../src/game/start-flow.js';
import type { GameStartPayload } from '../src/output/contract.js';
import {
  createFakeSpawner,
  createMemorySink,
  createTempConfig,
  startFakeGameServer,
  waitUntil,
  type FakeGameServer,
  type FakeSpawner,
  type MemorySink,
  type TempConfig,
} from './helpers.js';

const SDK_TOKEN = 'artel_sdk_token_that_must_never_be_in_argv';
const CONSOLE_BASE_URL = 'https://console.example.test';

function instance(overrides: Partial<GameInstance> = {}): GameInstance {
  return {
    id: 'instance-1',
    projectId: '42',
    name: 'my-instance',
    platform: 'UNITY',
    connected: true,
    lastConnectedAt: '2026-09-03T00:00:05Z',
    createdAt: '2026-09-03T00:00:00Z',
    updatedAt: '2026-09-03T00:00:05Z',
    ...overrides,
  };
}

let temp: TempConfig;
let spawner: FakeSpawner;

beforeEach(async () => {
  temp = await createTempConfig();
  spawner = createFakeSpawner();
});

afterEach(async () => {
  await temp.cleanup();
});

function deps(api: FakeGameServer, overrides: Partial<GameStartDeps> = {}): GameStartDeps {
  return {
    spawn: spawner.spawn,
    fetchImpl: globalThis.fetch,
    notify: () => undefined,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    pollIntervalMs: 5,
    generateLogPath: () => `${temp.root}/game.log`,
    ...overrides,
  };
}

describe('runGameStartFlow', () => {
  it('registers the child and reports the newly appeared instance', async () => {
    const api = await startFakeGameServer({
      sdkToken: SDK_TOKEN,
      instanceSequence: [[], [instance()]],
    });
    try {
      const result = await runGameStartFlow(
        {
          apiBaseUrl: api.baseUrl,
          consoleBaseUrl: CONSOLE_BASE_URL,
          cliToken: 'artel_cli_token',
          build: '/games/my-game',
          projectId: '42',
          width: 1280,
          height: 720,
          registrationTimeoutMs: 2_000,
          processEnv: { PATH: '/usr/bin' },
        },
        deps(api),
      );

      expect(result.instance.id).toBe('instance-1');
      expect(api.mintCalls).toHaveLength(1);
      expect(api.mintCalls[0]?.authorization).toBe('Bearer artel_cli_token');
      expect(api.listCalls.every((call) => call.projectId === '42')).toBe(true);
    } finally {
      await api.close();
    }
  });

  it('puts the SDK token in the child environment, never in argv', async () => {
    const api = await startFakeGameServer({
      sdkToken: SDK_TOKEN,
      instanceSequence: [[], [instance()]],
    });
    try {
      await runGameStartFlow(
        {
          apiBaseUrl: api.baseUrl,
          consoleBaseUrl: CONSOLE_BASE_URL,
          cliToken: 'artel_cli_token',
          build: '/games/my-game',
          projectId: '42',
          width: 1280,
          height: 720,
          registrationTimeoutMs: 2_000,
          processEnv: { PATH: '/usr/bin' },
        },
        deps(api),
      );

      expect(spawner.calls).toHaveLength(1);
      const call = spawner.calls[0];
      expect(call?.env.ARTEL_SDK_TOKEN).toBe(SDK_TOKEN);
      expect(call?.args.join(' ')).not.toContain(SDK_TOKEN);
      expect(call?.args).not.toContain('-batchmode');
    } finally {
      await api.close();
    }
  });

  it('fails with game_registration_timeout when the instance never appears', async () => {
    const api = await startFakeGameServer({ sdkToken: SDK_TOKEN, instanceSequence: [[]] });
    try {
      const failure = (await runGameStartFlow(
        {
          apiBaseUrl: api.baseUrl,
          consoleBaseUrl: CONSOLE_BASE_URL,
          cliToken: 'artel_cli_token',
          build: '/games/my-game',
          projectId: '42',
          width: 1280,
          height: 720,
          registrationTimeoutMs: 30,
          processEnv: {},
        },
        deps(api),
      ).catch((error: unknown) => error)) as CliError;

      expect(failure.code).toBe('game_registration_timeout');
      expect(failure.message).toContain(`${temp.root}/game.log`);
    } finally {
      await api.close();
    }
  });

  it('fails with game_exited_before_registration when the child dies first', async () => {
    const api = await startFakeGameServer({ sdkToken: SDK_TOKEN, instanceSequence: [[]] });
    try {
      const promise = runGameStartFlow(
        {
          apiBaseUrl: api.baseUrl,
          consoleBaseUrl: CONSOLE_BASE_URL,
          cliToken: 'artel_cli_token',
          build: '/games/my-game',
          projectId: '42',
          width: 1280,
          height: 720,
          registrationTimeoutMs: 5_000,
          processEnv: {},
        },
        deps(api),
      );

      // 자식이 실제로 spawn 된 뒤에 죽었다고 알린다 — flow 가 이미 polling loop 에 들어간 뒤여야 한다.
      await waitUntil(() => spawner.processes.length > 0);
      spawner.processes[0]?.fireExit(1, null);

      const failure = (await promise.catch((error: unknown) => error)) as CliError;
      expect(failure.code).toBe('game_exited_before_registration');
      expect(failure.message).toContain('code 1');
    } finally {
      await api.close();
    }
  });

  it('fails with sdk_token_not_supported when the mint endpoint is missing', async () => {
    const api = await startFakeGameServer({
      sdkToken: SDK_TOKEN,
      mintNotSupported: true,
      instanceSequence: [[]],
    });
    try {
      const failure = (await runGameStartFlow(
        {
          apiBaseUrl: api.baseUrl,
          consoleBaseUrl: CONSOLE_BASE_URL,
          cliToken: 'artel_cli_token',
          build: '/games/my-game',
          projectId: '42',
          width: 1280,
          height: 720,
          registrationTimeoutMs: 1_000,
          processEnv: {},
        },
        deps(api),
      ).catch((error: unknown) => error)) as CliError;

      expect(failure.code).toBe('sdk_token_not_supported');
      expect(spawner.calls).toHaveLength(0);
    } finally {
      await api.close();
    }
  });

  it('fails with game_build_not_found when the executable does not exist', async () => {
    const api = await startFakeGameServer({ sdkToken: SDK_TOKEN, instanceSequence: [[]] });
    try {
      spawner.failNext(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));

      const failure = (await runGameStartFlow(
        {
          apiBaseUrl: api.baseUrl,
          consoleBaseUrl: CONSOLE_BASE_URL,
          cliToken: 'artel_cli_token',
          build: '/games/does-not-exist',
          projectId: '42',
          width: 1280,
          height: 720,
          registrationTimeoutMs: 1_000,
          processEnv: {},
        },
        deps(api),
      ).catch((error: unknown) => error)) as CliError;

      expect(failure.code).toBe('game_build_not_found');
    } finally {
      await api.close();
    }
  });
});

describe('artel game start (command layer)', () => {
  it('fails with no_credential when nothing is signed in', async () => {
    const sink = createMemorySink();
    const failure = (await runGameStart(
      {
        json: true,
        project: '42',
        build: '/games/my-game',
        width: 1280,
        height: 720,
        timeoutSeconds: 5,
      },
      sink,
      // console 주소까지 준다. 이 테스트가 보는 것은 자격증명이지 설정이 아니고,
      // loopback API 에 console 을 비워 두면 설정 쪽이 먼저 걸린다.
      {
        ARTEL_CONFIG_DIR: temp.configDir,
        ARTEL_API_BASE_URL: 'http://127.0.0.1:1',
        ARTEL_CONSOLE_BASE_URL: 'http://127.0.0.1:5173',
      },
    ).catch((error: unknown) => error)) as CliError;

    expect(failure.code).toBe('no_credential');
  });

  it('refuses a loopback API paired with the default production console', async () => {
    const sink = createMemorySink();
    const failure = (await runGameStart(
      {
        json: true,
        project: '42',
        build: '/games/my-game',
        width: 1280,
        height: 720,
        timeoutSeconds: 5,
      },
      sink,
      { ARTEL_CONFIG_DIR: temp.configDir, ARTEL_API_BASE_URL: 'http://localhost:8080' },
    ).catch((error: unknown) => error)) as CliError;

    // 그 짝으로는 로그인 왕복이 성립할 수 없다. 기본값으로 때우면 게임에는
    // `-artel-frontend https://artel.kr` 이 박히고, 오버레이가 로그인을 물어야 하는
    // 순간에야 드러난다.
    expect(failure.code).toBe('missing_console_base_url');
  });

  it('emits exactly its contracted --json keys on success', async () => {
    const api = await startFakeGameServer({
      sdkToken: SDK_TOKEN,
      instanceSequence: [[], [instance()]],
    });
    try {
      const sink: MemorySink = createMemorySink();
      await runGameStart(
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
        () => deps(api),
      );

      const payload = sink.lastJson<GameStartPayload>();
      expect(Object.keys(payload).sort()).toEqual(
        [
          'build',
          'frontendUrl',
          'instanceId',
          'launched',
          'logFilePath',
          'pid',
          'projectId',
          'registeredAt',
          'secure',
          'serverAddress',
        ].sort(),
      );
      expect(payload.instanceId).toBe('instance-1');
      expect(sink.stdout).toHaveLength(1);
      expect(sink.everything()).not.toContain(SDK_TOKEN);
      expect(sink.everything()).not.toContain('artel_cli_token');
    } finally {
      await api.close();
    }
  });
});
