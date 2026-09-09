import fs from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runQaMatrix } from '../src/commands/qa/matrix.js';
import { runQaRun } from '../src/commands/qa/run.js';
import type { GameProcessSpawner } from '../src/game/process.js';
import type { GameStartDeps } from '../src/game/start-flow.js';
import type { CliError } from '../src/errors.js';
import type { QaMatrixPayload } from '../src/output/contract.js';
import { assignToSlots, expandCombinations, type MatrixAxes } from '../src/qa/matrix.js';
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

/** 축을 안 준 자리를 `[null]` 로 채운다. 그 축은 서버 기본값으로 한 번만 돈다. */
function axes(partial: Partial<MatrixAxes>): MatrixAxes {
  return {
    testRunIds: ['1'],
    models: [null],
    promptVersions: [null],
    reasoningEfforts: [null],
    arches: [null],
    contentMapModes: [null],
    knowledgeModes: [null],
    ...partial,
  };
}

describe('expandCombinations', () => {
  it('walks the axes in the order they are declared, every time', () => {
    const given = axes({
      testRunIds: ['1', '2'],
      contentMapModes: ['off', 'frozen'],
      knowledgeModes: ['off'],
    });

    const first = expandCombinations(given);
    const second = expandCombinations(given);

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

  /**
   * `qa diff` 는 model 축으로 비교할 수 있는데 그 축으로 런을 만드는 수단이 없었다. 이 축이
   * 실제로 곱해지는지가 그 구멍이 막혔다는 증거다.
   */
  it('multiplies the model axis with the others', () => {
    const combinations = expandCombinations(
      axes({
        models: ['openai/gpt-5.6-luna', 'anthropic/claude-haiku'],
        contentMapModes: ['off', 'frozen'],
      }),
    );

    expect(combinations).toHaveLength(4);
    expect(
      combinations.map((combination) => [combination.model, combination.contentMapMode]),
    ).toEqual([
      ['openai/gpt-5.6-luna', 'off'],
      ['openai/gpt-5.6-luna', 'frozen'],
      ['anthropic/claude-haiku', 'off'],
      ['anthropic/claude-haiku', 'frozen'],
    ]);
  });

  /**
   * 값이 하나면 그 축은 조합을 늘리지 않고 전 조합에 고정된다. 축으로 주지 않으면 서버가 매
   * 런마다 자기 기본값을 고르고, 그 기본값이 도는 중에 바뀌면 서로 다른 model 로 돈 결과가 한
   * 표에 섞인다 — 그것이 이 이슈가 막으려는 것이다.
   */
  it('pins an axis given exactly one value across every combination', () => {
    const combinations = expandCombinations(
      axes({
        testRunIds: ['1', '2'],
        models: ['openai/gpt-5.6-luna'],
      }),
    );

    expect(combinations).toHaveLength(2);
    expect(combinations.every((c) => c.model === 'openai/gpt-5.6-luna')).toBe(true);
  });

  /**
   * QA agent 의 런은 결정적이지 않다. 조합당 한 번씩 돌린 표로 두 arm 을 비교하면, 본 차이가
   * arm 때문인지 그날의 운인지 구분할 수 없다.
   */
  it('repeats each combination the asked number of times', () => {
    const combinations = expandCombinations(axes({ testRunIds: ['1', '2'] }), 3);

    expect(combinations).toHaveLength(6);
    expect(combinations.map((c) => [c.combination, c.repeat])).toEqual([
      [0, 0],
      [0, 1],
      [0, 2],
      [1, 0],
      [1, 1],
      [1, 2],
    ]);
  });

  /**
   * 반복을 축으로 두면 `--repeat` 을 켜는 것만으로 조합 번호와 슬롯 배정이 통째로 달라진다.
   * 가장 안쪽에 두면 `--repeat 1` 일 때의 번호가 그대로 유지된다.
   */
  it('leaves the numbering of a single-run matrix untouched', () => {
    const given = axes({ testRunIds: ['1', '2'], contentMapModes: ['off', 'frozen'] });

    expect(expandCombinations(given, 1)).toEqual(expandCombinations(given));
  });

  it('gives the repeats of one combination the same axis values', () => {
    const combinations = expandCombinations(axes({ models: ['openai/gpt-5.6-luna'] }), 2);

    expect(combinations).toHaveLength(2);
    expect(combinations[0]?.model).toBe(combinations[1]?.model);
    expect(combinations[0]?.combination).toBe(combinations[1]?.combination);
    expect(combinations[0]?.repeat).not.toBe(combinations[1]?.repeat);
  });

  it('keeps an axis with no flag as a single combination that names no value', () => {
    // `null` 은 그 축의 flag 를 주지 않았다는 뜻이다. 조합은 그대로 하나 생기고, body 에는
    // 그 키가 실리지 않아 서버가 자기 기본값을 쓴다.
    const combinations = expandCombinations(axes({}));

    expect(combinations).toHaveLength(1);
    expect(combinations[0]?.model).toBeNull();
    expect(combinations[0]?.promptVersion).toBeNull();
    expect(combinations[0]?.reasoningEffort).toBeNull();
    expect(combinations[0]?.arch).toBeNull();
    expect(combinations[0]?.contentMapMode).toBeNull();
    expect(combinations[0]?.knowledgeMode).toBeNull();
  });

  /**
   * `--arch` 가 축이 됐다. 안 준 값이 아니라 실제 arch 값 둘을 줬을 때, 다른 축과 똑같이
   * 곱해지고 선언 순서(`model` · `promptVersion` · `reasoningEffort` · `arch` ·
   * `contentMapMode` · `knowledgeMode`)대로 자리가 정해지는지가 이 테스트다.
   */
  it('multiplies the arch axis with the others, in declared flag order', () => {
    const onDemand = { label: 'v4-capture-on-demand', value: { screen_capture: 'on_demand' } };
    const everyCall = { label: 'v4-capture-every-call', value: { screen_capture: 'every_call' } };

    const combinations = expandCombinations(
      axes({ arches: [onDemand, everyCall], contentMapModes: ['off', 'frozen'] }),
    );

    expect(combinations).toHaveLength(4);
    expect(combinations.map((c) => [c.arch?.label, c.contentMapMode])).toEqual([
      [onDemand.label, 'off'],
      [onDemand.label, 'frozen'],
      [everyCall.label, 'off'],
      [everyCall.label, 'frozen'],
    ]);
  });
});

describe('assignToSlots', () => {
  it('sends the same combination to the same slot on every run', () => {
    const combinations = expandCombinations(
      axes({
        testRunIds: ['1', '2'],
        contentMapModes: ['off', 'frozen'],
        knowledgeModes: ['off'],
      }),
    );

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

  /** 반복을 켜도 배정이 결정적이어야 한다. 그래야 같은 명령 두 번의 결과를 나란히 놓는다. */
  it('sends the repeats of one combination to the same slots on every run', () => {
    const combinations = expandCombinations(axes({ testRunIds: ['1', '2'] }), 3);

    const first = assignToSlots(combinations, 2).map((slot) =>
      slot.map((combination) => [combination.combination, combination.repeat]),
    );
    const second = assignToSlots(combinations, 2).map((slot) =>
      slot.map((combination) => [combination.combination, combination.repeat]),
    );

    expect(second).toEqual(first);
  });

  it('gives every combination exactly one slot', () => {
    const combinations = expandCombinations(
      axes({
        testRunIds: ['1', '2', '3'],
        contentMapModes: ['on', 'off'],
        knowledgeModes: ['learning'],
      }),
    );

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
      // 축을 주지 않으면 `[null]` 한 칸이다 — 그 축은 서버 기본값으로 한 번만 돈다.
      models: [null],
      promptVersions: [null],
      reasoningEfforts: [null],
      contentMapModes: ['off', 'frozen'],
      knowledgeModes: [null],
      archSpecs: [],
      repeats: 1,
      resume: false,
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

  /**
   * 한 조합이 몇 분씩 걸린다. 중간에 죽으면 그때까지 끝난 런의 판정도 함께 사라지는 것이 이
   * 기능이 푸는 문제다.
   */
  it('appends each finished run to --out as it finishes', async () => {
    api = await startFakeMatrixServer({ sdkToken: 'sdk_token' });
    const out = `${temp.root}/matrix.jsonl`;

    await runQaMatrix(
      { ...baseOptions(), testRunIds: ['1'], contentMapModes: ['off', 'frozen'], out },
      createMemorySink(),
      matrixEnv(),
      makeStartDeps(),
    );

    const lines = (await fs.readFile(out, 'utf8')).trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(
      lines.map((line) => (JSON.parse(line) as { contentMapMode: string }).contentMapMode),
    ).toEqual(expect.arrayContaining(['off', 'frozen']));
  });

  it('skips the runs already in the journal and launches no game for them', async () => {
    api = await startFakeMatrixServer({ sdkToken: 'sdk_token' });
    const out = `${temp.root}/matrix.jsonl`;
    const options = {
      ...baseOptions(),
      testRunIds: ['1'],
      contentMapModes: ['off', 'frozen'],
      out,
    };

    await runQaMatrix(options, createMemorySink(), matrixEnv(), makeStartDeps());
    await api.close();

    // 두 번째 서버는 launch 를 하나도 받지 않아야 한다.
    api = await startFakeMatrixServer({ sdkToken: 'sdk_token' });
    const sink = createMemorySink();
    const code = await runQaMatrix(
      { ...options, resume: true },
      sink,
      matrixEnv(),
      makeStartDeps(),
    );

    expect(api.timeline).toEqual([]);
    expect(code).toBe(EXIT_OK);
    const payload = sink.lastJson<QaMatrixPayload>();
    expect(payload.total).toBe(2);
    expect(payload.succeeded).toBe(2);
  });

  /** 이어 돌린 것과 처음부터 돈 것의 최종 결과가 같아야 한다. */
  it('reports the same payload whether it resumed or ran the whole way', async () => {
    api = await startFakeMatrixServer({ sdkToken: 'sdk_token' });
    const options = {
      ...baseOptions(),
      testRunIds: ['1'],
      contentMapModes: ['off', 'frozen'],
    };

    const fresh = createMemorySink();
    await runQaMatrix(options, fresh, matrixEnv(), makeStartDeps());
    await api.close();

    api = await startFakeMatrixServer({ sdkToken: 'sdk_token' });
    const out = `${temp.root}/matrix.jsonl`;
    await runQaMatrix({ ...options, out }, createMemorySink(), matrixEnv(), makeStartDeps());
    const resumed = createMemorySink();
    await runQaMatrix({ ...options, out, resume: true }, resumed, matrixEnv(), makeStartDeps());

    const a = fresh.lastJson<QaMatrixPayload>();
    const b = resumed.lastJson<QaMatrixPayload>();
    expect(b.combinations.map((c) => [c.index, c.contentMapMode, c.verdict])).toEqual(
      a.combinations.map((c) => [c.index, c.contentMapMode, c.verdict]),
    );
  });

  /** 다른 실험의 파일에 이어 쓰면 한 표에 두 실험이 섞인다. 게임을 띄우기 전에 멈춰야 한다. */
  it('refuses a journal from a different set of axes before launching anything', async () => {
    api = await startFakeMatrixServer({ sdkToken: 'sdk_token' });
    const out = `${temp.root}/matrix.jsonl`;

    await runQaMatrix(
      { ...baseOptions(), testRunIds: ['1'], contentMapModes: ['frozen'], out },
      createMemorySink(),
      matrixEnv(),
      makeStartDeps(),
    );
    await api.close();

    api = await startFakeMatrixServer({ sdkToken: 'sdk_token' });
    const failure = (await runQaMatrix(
      { ...baseOptions(), testRunIds: ['1'], contentMapModes: ['off'], out, resume: true },
      createMemorySink(),
      matrixEnv(),
      makeStartDeps(),
    ).catch((error: unknown) => error)) as CliError;

    expect(failure.code).toBe('matrix_journal_mismatch');
    expect(api.timeline).toEqual([]);
  });

  it('refuses --resume without --out through the CLI', async () => {
    api = await startFakeMatrixServer({ sdkToken: 'sdk_token' });

    const code = await runCli(
      ['qa', 'matrix', '--project', '42', '--test-run', '1', '--slot', BUILD_A, '--resume'],
      createMemorySink(),
      matrixEnv(),
    );

    expect(code).toBe(EXIT_USAGE);
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
      'archLabel',
      'build',
      'combination',
      'contentMapMode',
      'durationMs',
      'error',
      'gameInstanceId',
      'index',
      'knowledgeMode',
      'model',
      'promptVersion',
      'qaRunId',
      'reasoningEffort',
      'repeat',
      'slot',
      'status',
      'stepsPassed',
      'stepsTotal',
      'testRunId',
      'usage',
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

  describe('the --arch axis', () => {
    it('sends each arch value to the server body, and omits the key when --arch is omitted', async () => {
      api = await startFakeMatrixServer({ sdkToken: 'sdk_token' });

      await runQaMatrix(
        {
          ...baseOptions(),
          testRunIds: ['1'],
          contentMapModes: [null],
          archSpecs: [
            JSON.stringify({ label: 'v4-capture-every-call', screen_capture: 'every_call' }),
          ],
        },
        createMemorySink(),
        matrixEnv(),
        makeStartDeps(),
      );
      expect(api.createBodies[0]?.arch).toEqual({
        label: 'v4-capture-every-call',
        screen_capture: 'every_call',
      });
      await api.close();

      api = await startFakeMatrixServer({ sdkToken: 'sdk_token' });
      await runQaMatrix(
        { ...baseOptions(), testRunIds: ['1'], contentMapModes: [null] },
        createMemorySink(),
        matrixEnv(),
        makeStartDeps(),
      );
      expect(Object.keys(api.createBodies[0] ?? {})).not.toContain('arch');
    });

    /**
     * label 이 human 출력·`--json`·`--out` 세 곳 모두에 닿아야 한다 — arch object 전체가
     * 아니라 그 이름만으로 조합을 알아볼 수 있어야 `--resume` 도 같은 이름을 쓴다.
     */
    it('names the combination by the arch label in human output, --json, and --out', async () => {
      api = await startFakeMatrixServer({ sdkToken: 'sdk_token' });
      const out = `${temp.root}/matrix.jsonl`;
      const sink = createMemorySink();

      await runQaMatrix(
        {
          ...baseOptions(),
          json: false,
          testRunIds: ['1'],
          contentMapModes: [null],
          archSpecs: [JSON.stringify({ label: 'v4-capture-every-call' })],
          out,
        },
        sink,
        matrixEnv(),
        makeStartDeps(),
      );

      expect(sink.everything()).toContain('arch=v4-capture-every-call');

      const lines = (await fs.readFile(out, 'utf8')).trimEnd().split('\n');
      expect(lines.map((line) => (JSON.parse(line) as { archLabel: string }).archLabel)).toEqual([
        'v4-capture-every-call',
      ]);
    });

    it('rejects an arch value with no "label" field, before any run starts', async () => {
      api = await startFakeMatrixServer({ sdkToken: 'sdk_token' });

      const failure = (await runQaMatrix(
        {
          ...baseOptions(),
          testRunIds: ['1'],
          archSpecs: [JSON.stringify({ screen_capture: 'every_call' })],
        },
        createMemorySink(),
        matrixEnv(),
        makeStartDeps(),
      ).catch((error: unknown) => error)) as CliError;

      expect(failure.code).toBe('qa_invalid_arch');
      expect(api.timeline).toEqual([]);
    });

    it('rejects an unreadable --arch file, before any run starts', async () => {
      api = await startFakeMatrixServer({ sdkToken: 'sdk_token' });

      const failure = (await runQaMatrix(
        {
          ...baseOptions(),
          testRunIds: ['1'],
          archSpecs: [`@${temp.root}/missing-arch.json`],
        },
        createMemorySink(),
        matrixEnv(),
        makeStartDeps(),
      ).catch((error: unknown) => error)) as CliError;

      expect(failure.code).toBe('qa_invalid_arch');
      expect(api.timeline).toEqual([]);
    });

    /**
     * 같은 object 를 인라인과 `@경로` 로 한 번씩 준 것이 이 검사가 잡으려는 오타다. 파일과
     * 인라인의 키 순서를 다르게 줘서, 원문 문자열 비교였다면 놓쳤을 경우를 확인한다.
     */
    it('rejects the same arch structure given twice — once inline, once as @path — before any run starts', async () => {
      api = await startFakeMatrixServer({ sdkToken: 'sdk_token' });
      const archPath = `${temp.root}/arch.json`;
      const label = 'v4-capture-every-call';
      await fs.writeFile(archPath, JSON.stringify({ screen_capture: 'every_call', label }), 'utf8');

      const failure = (await runQaMatrix(
        {
          ...baseOptions(),
          testRunIds: ['1'],
          archSpecs: [JSON.stringify({ label, screen_capture: 'every_call' }), `@${archPath}`],
        },
        createMemorySink(),
        matrixEnv(),
        makeStartDeps(),
      ).catch((error: unknown) => error)) as CliError;

      expect(failure.code).toBe('qa_duplicate_arch');
      expect(api.timeline).toEqual([]);
    });

    /**
     * label 이 조합의 정체 전부다(`keyOfCombination`, `describeCombination` 참고). 두
     * arch object 가 서로 달라도 label 이 같으면 `--out` 에 같은 열쇠로 적히고, 그중 하나가
     * 사라진 것처럼 보인다 — 파일을 복사해 knob 만 고치고 label 을 그대로 둔 실수다.
     */
    it('rejects two different arch structures sharing the same label, before any run starts', async () => {
      api = await startFakeMatrixServer({ sdkToken: 'sdk_token' });
      const label = 'v4-capture-every-call';

      const failure = (await runQaMatrix(
        {
          ...baseOptions(),
          testRunIds: ['1'],
          archSpecs: [
            JSON.stringify({ label, screen_capture: 'every_call' }),
            JSON.stringify({ label, screen_capture: 'on_demand' }),
          ],
        },
        createMemorySink(),
        matrixEnv(),
        makeStartDeps(),
      ).catch((error: unknown) => error)) as CliError;

      expect(failure.code).toBe('qa_duplicate_arch');
      expect(api.timeline).toEqual([]);
    });

    /**
     * `--resume` 은 arch label 이 다르면 다른 조합으로 봐야 한다. 안 그러면 같은 test run 의
     * 두 arm 중 하나를 돌리고 나서 나머지 arm 을 "이미 돌았다" 며 건너뛴다.
     */
    it('treats two arms of the same test run as different combinations when resuming', async () => {
      api = await startFakeMatrixServer({ sdkToken: 'sdk_token' });
      const out = `${temp.root}/matrix.jsonl`;
      const archSpecs = [
        JSON.stringify({ label: 'v4-capture-on-demand' }),
        JSON.stringify({ label: 'v4-capture-every-call' }),
      ];

      await runQaMatrix(
        { ...baseOptions(), testRunIds: ['1'], contentMapModes: [null], archSpecs, out },
        createMemorySink(),
        matrixEnv(),
        makeStartDeps(),
      );
      await api.close();

      // 두 번째 서버는 두 arm 다 이미 끝난 것으로 읽고 launch 를 하나도 받지 않아야 한다 —
      // arch label 이 다른데 하나로 뭉개지면 한쪽 arm 을 "이미 돌았다" 며 건너뛰게 된다.
      api = await startFakeMatrixServer({ sdkToken: 'sdk_token' });
      const sink = createMemorySink();
      const code = await runQaMatrix(
        {
          ...baseOptions(),
          testRunIds: ['1'],
          contentMapModes: [null],
          archSpecs,
          out,
          resume: true,
        },
        sink,
        matrixEnv(),
        makeStartDeps(),
      );

      expect(api.timeline).toEqual([]);
      expect(code).toBe(EXIT_OK);
      const payload = sink.lastJson<QaMatrixPayload>();
      expect(payload.combinations.map((c) => c.archLabel).sort()).toEqual([
        'v4-capture-every-call',
        'v4-capture-on-demand',
      ]);
    });
  });
});
