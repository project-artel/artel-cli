import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runQaMatrix } from '../src/commands/qa/matrix.js';
import { runQaRun } from '../src/commands/qa/run.js';
import type { GameProcessSpawner } from '../src/game/process.js';
import type { GameStartDeps } from '../src/game/start-flow.js';
import type { QaMatrixPayload } from '../src/output/contract.js';
import { assignToSlots, expandCombinations } from '../src/qa/matrix.js';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, runCli } from '../src/run.js';
import { createMemorySink, createTempConfig, type TempConfig } from './helpers.js';
import { startFakeMatrixServer, type FakeMatrixServer } from './matrix-helpers.js';
import { fakeQaRun, startFakeQaServer, type FakeQaServer } from './qa-helpers.js';

const BUILD_A = '/games/BuildA/WordVenture.exe';
const BUILD_B = '/games/BuildB/WordVenture.exe';
const CONSOLE_BASE_URL = 'https://console.example.test';

let temp: TempConfig;

beforeEach(async () => {
  temp = await createTempConfig();
});

afterEach(async () => {
  await temp.cleanup();
});

describe('expandCombinations', () => {
  it('walks the axes in the order the flags were written, every time', () => {
    const axes = {
      testRunIds: ['1', '2'],
      contentMapModes: ['off', 'frozen'],
      knowledgeModes: ['off'],
    };

    const first = expandCombinations(axes);
    const second = expandCombinations(axes);

    expect(first.map((combination) => [combination.testRunId, combination.contentMapMode])).toEqual(
      [
        ['1', 'off'],
        ['1', 'frozen'],
        ['2', 'off'],
        ['2', 'frozen'],
      ],
    );
    expect(second).toEqual(first);
    expect(first.map((combination) => combination.index)).toEqual([0, 1, 2, 3]);
  });

  it('keeps an axis with no flag as a single combination that names no value', () => {
    // `null` 은 그 축의 flag 를 주지 않았다는 뜻이다. 조합은 그대로 하나 생기고, body 에는
    // 그 키가 실리지 않아 서버가 자기 기본값을 쓴다.
    const combinations = expandCombinations({
      testRunIds: ['1'],
      contentMapModes: [null],
      knowledgeModes: [null],
    });

    expect(combinations).toHaveLength(1);
    expect(combinations[0]?.contentMapMode).toBeNull();
    expect(combinations[0]?.knowledgeMode).toBeNull();
  });
});

describe('assignToSlots', () => {
  it('sends the same combination to the same slot on every run', () => {
    const combinations = expandCombinations({
      testRunIds: ['1', '2'],
      contentMapModes: ['off', 'frozen'],
      knowledgeModes: ['off'],
    });

    const first = assignToSlots(combinations, 2).map((slot) =>
      slot.map((combination) => combination.index),
    );
    const second = assignToSlots(combinations, 2).map((slot) =>
      slot.map((combination) => combination.index),
    );

    expect(first).toEqual([
      [0, 2],
      [1, 3],
    ]);
    expect(second).toEqual(first);
  });

  it('gives every combination exactly one slot', () => {
    const combinations = expandCombinations({
      testRunIds: ['1', '2', '3'],
      contentMapModes: ['on', 'off'],
      knowledgeModes: ['learning'],
    });

    const slots = assignToSlots(combinations, 4);
    const placed = slots.flat().map((combination) => combination.index);

    expect(placed.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe('qa run axis flags', () => {
  let api: FakeQaServer;

  beforeEach(async () => {
    api = await startFakeQaServer({ run: fakeQaRun() });
  });

  afterEach(async () => {
    await api.close();
  });

  function env(): NodeJS.ProcessEnv {
    return {
      ARTEL_CONFIG_DIR: temp.configDir,
      ARTEL_API_BASE_URL: api.baseUrl,
      ARTEL_CONSOLE_BASE_URL: CONSOLE_BASE_URL,
      ARTEL_TOKEN: 'artel_matrix_token',
    };
  }

  it('leaves the axis keys out of the body entirely when no flag was given', async () => {
    // 빈 문자열을 실으면 서버가 그것을 값으로 읽고 400 으로 거절한다. 기본값으로 떨어지지 않는다.
    await runQaRun(
      { json: true, testRun: '1', instance: '1', force: false, wait: false, timeoutSeconds: 5 },
      createMemorySink(),
      env(),
    );

    const body = api.createBodies[0] as Record<string, unknown>;
    expect(Object.keys(body)).not.toContain('contentMapMode');
    expect(Object.keys(body)).not.toContain('knowledgeMode');
    expect(Object.keys(body)).not.toContain('label');
  });

  it('carries the axis values when the flags were given', async () => {
    await runQaRun(
      {
        json: true,
        testRun: '1',
        instance: '1',
        contentMapMode: 'frozen',
        knowledgeMode: 'off',
        label: '2x2-local-pilot',
        force: false,
        wait: false,
        timeoutSeconds: 5,
      },
      createMemorySink(),
      env(),
    );

    expect(api.createBodies[0]).toMatchObject({
      contentMapMode: 'frozen',
      knowledgeMode: 'off',
      label: '2x2-local-pilot',
    });
  });

  it('rejects an axis value the server would not accept, before any request goes out', async () => {
    const sink = createMemorySink();
    const code = await runCli(
      ['qa', 'run', '--test-run', '1', '--instance', '1', '--content-map-mode', 'nope'],
      sink,
      env(),
    );

    expect(code).toBe(EXIT_USAGE);
    expect(sink.everything()).toContain('--content-map-mode takes one of on, frozen, off');
    expect(api.createBodies).toHaveLength(0);
  });

  it('rejects a blank --label rather than sending a name nobody chose', async () => {
    const sink = createMemorySink();
    const code = await runCli(
      ['qa', 'run', '--test-run', '1', '--instance', '1', '--label', '   '],
      sink,
      env(),
    );

    expect(code).toBe(EXIT_USAGE);
    expect(api.createBodies).toHaveLength(0);
  });
});

describe('runQaMatrix', () => {
  let api: FakeMatrixServer;

  afterEach(async () => {
    await api.close();
  });

  function matrixEnv(): NodeJS.ProcessEnv {
    return {
      ARTEL_CONFIG_DIR: temp.configDir,
      ARTEL_API_BASE_URL: api.baseUrl,
      ARTEL_CONSOLE_BASE_URL: CONSOLE_BASE_URL,
      ARTEL_TOKEN: 'artel_matrix_token',
    };
  }

  function makeStartDeps(): (notify: (message: string) => void) => GameStartDeps {
    let logCount = 0;
    const spawn: GameProcessSpawner = (command) => {
      api.registerLaunch(command);
      let killed = false;
      return Promise.resolve({
        pid: 4242,
        onExit() {
          // 이 테스트에서 게임은 스스로 죽지 않는다. matrix 가 죽인다.
        },
        kill() {
          if (killed) {
            return;
          }
          killed = true;
          api.noteKill(command);
        },
      });
    };
    return (notify) => ({
      spawn,
      fetchImpl: globalThis.fetch,
      notify,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      pollIntervalMs: 5,
      generateLogPath: () => {
        logCount += 1;
        return `${temp.root}/game-${String(logCount)}.log`;
      },
    });
  }

  function baseOptions() {
    return {
      json: true,
      project: '42',
      testRunIds: ['1', '2'],
      contentMapModes: ['off', 'frozen'],
      knowledgeModes: [null],
      slots: [BUILD_A, BUILD_B],
      width: 1280,
      height: 720,
      launchTimeoutSeconds: 5,
      timeoutSeconds: 30,
      pollIntervalMs: 5,
    };
  }

  it('never overlaps two runs on one slot, and relaunches the game between them', async () => {
    api = await startFakeMatrixServer({ sdkToken: 'sdk_token' });
    const sink = createMemorySink();

    const code = await runQaMatrix(baseOptions(), sink, matrixEnv(), makeStartDeps());

    expect(code).toBe(EXIT_OK);
    // 슬롯마다 `launch → create → kill` 이 되풀이된다. `create` 둘이 `kill` 없이 잇달아
    // 나오면 그 슬롯이 런을 겹쳐 건 것이고, `kill` 뒤에 `launch` 가 없으면 앞 런이 남긴
    // 화면에서 다음 런이 시작한 것이다.
    for (const build of [BUILD_A, BUILD_B]) {
      const forBuild = api.timeline
        .filter((entry) => entry.endsWith(`:${build}`))
        .map((entry) => entry.split(':')[0]);
      expect(forBuild).toEqual(['launch', 'create', 'kill', 'launch', 'create', 'kill']);
    }
  });

  it('reports the combinations in expansion order however the slots finish', async () => {
    api = await startFakeMatrixServer({ sdkToken: 'sdk_token' });
    const sink = createMemorySink();

    await runQaMatrix(baseOptions(), sink, matrixEnv(), makeStartDeps());

    const payload = sink.lastJson<QaMatrixPayload>();
    expect(
      payload.combinations.map((combination) => [
        combination.index,
        combination.slot,
        combination.testRunId,
        combination.contentMapMode,
        combination.knowledgeMode,
      ]),
    ).toEqual([
      [0, 0, '1', 'off', null],
      [1, 1, '1', 'frozen', null],
      [2, 0, '2', 'off', null],
      [3, 1, '2', 'frozen', null],
    ]);
    expect(payload.combinations.every((combination) => combination.stepsTotal === 3)).toBe(true);
    expect(payload.total).toBe(4);
    expect(payload.succeeded).toBe(4);
  });

  it('emits exactly its contracted keys', async () => {
    // `--json` 의 키 집합은 공개 계약이다. 키를 지우거나 이름을 바꾸면 이 테스트가 깨진다.
    api = await startFakeMatrixServer({ sdkToken: 'sdk_token' });
    const sink = createMemorySink();

    await runQaMatrix(
      { ...baseOptions(), testRunIds: ['1'], contentMapModes: ['off'], slots: [BUILD_A] },
      sink,
      matrixEnv(),
      makeStartDeps(),
    );

    const payload = sink.lastJson<QaMatrixPayload>();
    expect(Object.keys(payload).sort()).toEqual([
      'combinations',
      'failed',
      'label',
      'projectId',
      'slots',
      'succeeded',
      'total',
    ]);
    expect(Object.keys(payload.combinations[0] ?? {}).sort()).toEqual([
      'build',
      'contentMapMode',
      'durationMs',
      'error',
      'gameInstanceId',
      'index',
      'knowledgeMode',
      'qaRunId',
      'slot',
      'status',
      'stepsPassed',
      'stepsTotal',
      'testRunId',
      'verdict',
    ]);
  });

  it('sends the axis values of each combination, and no empty string', async () => {
    api = await startFakeMatrixServer({ sdkToken: 'sdk_token' });

    await runQaMatrix(
      { ...baseOptions(), label: '2x2-local-pilot' },
      createMemorySink(),
      matrixEnv(),
      makeStartDeps(),
    );

    const sent = api.createBodies.map((body) => ({
      testRunId: body.testRunId,
      contentMapMode: body.contentMapMode,
      label: body.label,
    }));
    expect(sent).toHaveLength(4);
    expect(sent.every((body) => body.label === '2x2-local-pilot')).toBe(true);
    expect(
      sent.every((body) => body.contentMapMode === 'off' || body.contentMapMode === 'frozen'),
    ).toBe(true);
    // 안 준 축은 키 자체가 없다.
    expect(api.createBodies.every((body) => !Object.keys(body).includes('knowledgeMode'))).toBe(
      true,
    );
  });

  it('keeps the other combinations going when one fails, and does not exit 0', async () => {
    api = await startFakeMatrixServer({
      sdkToken: 'sdk_token',
      failCreate: (body) =>
        body.testRunId === '2' && body.contentMapMode === 'off'
          ? {
              status: 400,
              body: '{"code":"bad_request","message":"contentMapMode is not allowed"}',
            }
          : null,
    });
    const sink = createMemorySink();

    const code = await runQaMatrix(baseOptions(), sink, matrixEnv(), makeStartDeps());

    expect(code).toBe(EXIT_FAILURE);
    const payload = sink.lastJson<QaMatrixPayload>();
    expect(payload.total).toBe(4);
    expect(payload.failed).toBe(1);
    expect(payload.succeeded).toBe(3);

    const failed = payload.combinations.filter((combination) => combination.error !== null);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.testRunId).toBe('2');
    expect(failed[0]?.contentMapMode).toBe('off');
    expect(failed[0]?.status).toBe('NOT_STARTED');
    expect(failed[0]?.error?.message).toContain('contentMapMode is not allowed');

    // 실패한 조합과 같은 슬롯의 다음 조합은 그대로 돌았다.
    expect(
      payload.combinations.filter(
        (combination) => combination.slot === 0 && combination.qaRunId !== null,
      ),
    ).toHaveLength(1);
    expect(payload.combinations.filter((combination) => combination.qaRunId !== null)).toHaveLength(
      3,
    );
  });

  it('refuses two slots that name the same build', async () => {
    api = await startFakeMatrixServer({ sdkToken: 'sdk_token' });
    const sink = createMemorySink();

    const code = await runCli(
      ['qa', 'matrix', '--project', '42', '--test-run', '1', '--slot', BUILD_A, '--slot', BUILD_A],
      sink,
      matrixEnv(),
    );

    expect(code).toBe(EXIT_USAGE);
    expect(sink.everything()).toContain('productName');
    expect(api.createBodies).toHaveLength(0);
  });
});
