import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import { runScenarioApprove } from '../src/commands/scenario/approve.js';
import { runScenarioCreate } from '../src/commands/scenario/create.js';
import { runScenarioDelete } from '../src/commands/scenario/delete.js';
import { runScenarioExpectedLabels } from '../src/commands/scenario/expected-labels.js';
import { runScenarioList } from '../src/commands/scenario/list.js';
import { runScenarioShow } from '../src/commands/scenario/show.js';
import { runScenarioUpdate } from '../src/commands/scenario/update.js';
import { CliError, UsageError } from '../src/errors.js';
import type {
  ErrorEnvelope,
  ScenarioApprovePayload,
  ScenarioDeletePayload,
  ScenarioListPayload,
  ScenarioPayload,
} from '../src/output/contract.js';
import { EXIT_FAILURE, EXIT_OK, runCli } from '../src/run.js';
import { createMemorySink } from './helpers.js';
import {
  fakeScenario,
  startFakeScenarioServer,
  type FakeScenarioServer,
} from './scenario-helpers.js';

const SCENARIO_KEYS = ['description', 'projectId', 'scenarioId', 'steps', 'title'];
const STEP_KEYS = ['action', 'caseId', 'expectedPassed', 'hint', 'input', 'step'];
const LIST_KEYS = ['projectId', 'scenarios'];
const SUMMARY_KEYS = ['createdAt', 'projectId', 'scenarioId', 'title', 'updatedAt'];
const APPROVE_KEYS = ['approved', 'scenarioId'];
const DELETE_KEYS = ['deleted', 'forced', 'scenarioId'];

let api: FakeScenarioServer;

afterEach(async () => {
  await api.close();
});

function envFor(server: FakeScenarioServer): NodeJS.ProcessEnv {
  return { ARTEL_TOKEN: 'artel_test_token', ARTEL_API_BASE_URL: server.baseUrl };
}

function stdinOf(text: string): NodeJS.ReadableStream {
  return Readable.from([text]);
}

/** 파이프되지 않은 대화형 터미널 흉내. `isTTY` 만 있으면 되고, 읽히면 안 된다. */
function interactiveStdin(): NodeJS.ReadableStream {
  return { isTTY: true } as unknown as NodeJS.ReadableStream;
}

/**
 * `expect(promise).rejects.toMatchObject({ message: expect.stringContaining(...) })` 는
 * `expect.stringContaining` 이 `any` 라 타입 체크 아래서 unsafe assignment 로 걸린다. 같은
 * 검사를 `CliError` 타입으로 좁혀서 한다 — promise 는 이미 정착(settle)된 뒤라 두 번
 * 기다려도 부작용이 두 번 일어나지 않는다.
 */
async function expectCliFailure(
  promise: Promise<unknown>,
  code: string,
  messagePattern: RegExp,
): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(CliError);
  try {
    await promise;
    throw new Error('unreachable: the promise above already asserted a rejection');
  } catch (error) {
    const cliError = error as CliError;
    expect(cliError.code).toBe(code);
    expect(cliError.message).toMatch(messagePattern);
  }
}

describe('scenario list', () => {
  it('emits exactly its contracted keys, summary included', async () => {
    api = await startFakeScenarioServer({
      scenarios: [
        fakeScenario('1', { projectId: '7', title: 'Story intro' }),
        fakeScenario('2', { projectId: '7', title: 'Shop flow' }),
        fakeScenario('3', { projectId: '9', title: 'Other project' }),
      ],
    });

    const sink = createMemorySink();
    await runScenarioList({ json: true, project: '7' }, sink, envFor(api));

    const payload = sink.lastJson<ScenarioListPayload>();
    expect(Object.keys(payload).sort()).toEqual(LIST_KEYS);
    expect(payload.scenarios).toHaveLength(2);
    expect(Object.keys(payload.scenarios[0] ?? {}).sort()).toEqual(SUMMARY_KEYS);
    expect(payload.scenarios.map((item) => item.title).sort()).toEqual([
      'Shop flow',
      'Story intro',
    ]);
  });

  it('reports a project nobody can see as scenario_project_not_found', async () => {
    api = await startFakeScenarioServer({ inaccessibleProjectIds: ['7'] });

    const sink = createMemorySink();
    const code = await runCli(
      ['scenario', 'list', '--project', '7', '--api-url', api.baseUrl, '--json'],
      sink,
      envFor(api),
    );

    expect(code).toBe(EXIT_FAILURE);
    expect(sink.lastJson<ErrorEnvelope>().error.code).toBe('scenario_project_not_found');
  });
});

describe('scenario create', () => {
  it('creates an empty scenario, then saves steps read from standard input', async () => {
    api = await startFakeScenarioServer();

    const sink = createMemorySink();
    await runScenarioCreate(
      {
        json: true,
        project: '7',
        title: 'New scenario',
        description: 'Covers the tutorial.',
        steps: undefined,
      },
      sink,
      envFor(api),
      stdinOf(
        JSON.stringify([
          { action: 'open the game' },
          { action: 'confirm tutorial banner shows', case_id: 5, hint: 'tutorial-banner' },
        ]),
      ),
    );

    const payload = sink.lastJson<ScenarioPayload>();
    expect(Object.keys(payload).sort()).toEqual(SCENARIO_KEYS);
    expect(Object.keys(payload.steps[0] ?? {}).sort()).toEqual(STEP_KEYS);
    expect(payload).toMatchObject({ title: 'New scenario', description: 'Covers the tutorial.' });
    expect(payload.steps).toEqual([
      {
        step: 1,
        action: 'open the game',
        caseId: null,
        hint: null,
        input: null,
        expectedPassed: null,
      },
      {
        step: 2,
        action: 'confirm tutorial banner shows',
        caseId: 5,
        hint: 'tutorial-banner',
        input: null,
        expectedPassed: null,
      },
    ]);
    expect(api.createBodies).toEqual([{ projectId: 7 }]);
  });

  it('refuses a malformed steps array before any request, naming the field and position', async () => {
    api = await startFakeScenarioServer();
    const sink = createMemorySink();

    await expectCliFailure(
      runScenarioCreate(
        { json: true, project: '7', steps: undefined },
        sink,
        envFor(api),
        stdinOf(JSON.stringify([{ action: 'ok' }, { caseId: 1, action: 'typo of case_id' }])),
      ),
      'scenario_invalid_steps',
      /steps\[1\] has an unknown field "caseId"/,
    );
    expect(api.createBodies).toHaveLength(0);
  });

  it('rejects an empty action, a non-array top level, and a non-object element', async () => {
    api = await startFakeScenarioServer();
    const sink = createMemorySink();

    await expectCliFailure(
      runScenarioCreate(
        { json: true, project: '7', steps: undefined },
        sink,
        envFor(api),
        stdinOf(JSON.stringify([{ action: '' }])),
      ),
      'scenario_invalid_steps',
      /steps\[0\]\.action must be a non-empty string/,
    );

    await expectCliFailure(
      runScenarioCreate(
        { json: true, project: '7', steps: undefined },
        sink,
        envFor(api),
        stdinOf(JSON.stringify({ action: 'not an array' })),
      ),
      'scenario_invalid_steps',
      /steps must be a JSON array, not object/,
    );

    await expectCliFailure(
      runScenarioCreate(
        { json: true, project: '7', steps: undefined },
        sink,
        envFor(api),
        stdinOf(JSON.stringify(['just a string'])),
      ),
      'scenario_invalid_steps',
      /steps\[0\] must be a JSON object, not string/,
    );
  });

  it('rejects malformed JSON with the native parser message, and never opens a connection', async () => {
    api = await startFakeScenarioServer();
    const sink = createMemorySink();

    await expect(
      runScenarioCreate(
        { json: true, project: '7', steps: undefined },
        sink,
        envFor(api),
        stdinOf('{not valid json'),
      ),
    ).rejects.toMatchObject({ code: 'scenario_invalid_steps' });
    expect(api.createBodies).toHaveLength(0);
  });

  it('refuses to hang on an interactive terminal with no --steps and nothing piped', async () => {
    api = await startFakeScenarioServer();
    const sink = createMemorySink();

    await expect(
      runScenarioCreate(
        { json: true, project: '7', steps: undefined },
        sink,
        envFor(api),
        interactiveStdin(),
      ),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it('names the created scenario id when saving its steps fails, so the user can retry update', async () => {
    api = await startFakeScenarioServer({
      updateFailsWith: { status: 500, body: '{"message":"db is down"}' },
    });
    const sink = createMemorySink();

    await expectCliFailure(
      runScenarioCreate(
        { json: true, project: '7', steps: undefined },
        sink,
        envFor(api),
        stdinOf(JSON.stringify([{ action: 'ok' }])),
      ),
      'server_error',
      /artel scenario update 101/,
    );
  });
});

describe('scenario show', () => {
  it('reads a scenario back with its steps in order', async () => {
    api = await startFakeScenarioServer({ scenarios: [fakeScenario('1', { projectId: '7' })] });
    const sink = createMemorySink();

    await runScenarioShow('1', { json: true }, sink, envFor(api));

    const payload = sink.lastJson<ScenarioPayload>();
    expect(payload.scenarioId).toBe('1');
    expect(payload.projectId).toBe('7');
    expect(payload.steps).toHaveLength(2);
    expect(payload.steps[1]).toMatchObject({ caseId: 42, expectedPassed: true });
  });

  it('reports a missing scenario as scenario_not_found', async () => {
    api = await startFakeScenarioServer();
    const sink = createMemorySink();
    const code = await runCli(
      ['scenario', 'show', '999', '--api-url', api.baseUrl, '--json'],
      sink,
      envFor(api),
    );

    expect(code).toBe(EXIT_FAILURE);
    expect(sink.lastJson<ErrorEnvelope>().error.code).toBe('scenario_not_found');
  });
});

describe('scenario update', () => {
  it('changes only the title, leaving steps untouched and standard input unread', async () => {
    api = await startFakeScenarioServer({ scenarios: [fakeScenario('1')] });
    const sink = createMemorySink();

    await runScenarioUpdate(
      '1',
      { json: true, title: 'Renamed', steps: undefined },
      sink,
      envFor(api),
      interactiveStdin(),
    );

    const payload = sink.lastJson<ScenarioPayload>();
    expect(payload.title).toBe('Renamed');
    expect(payload.steps).toHaveLength(2);
    expect(payload.steps[1]?.caseId).toBe(42);
  });

  it('replaces steps when --steps is given, and carries over a matching label', async () => {
    api = await startFakeScenarioServer({ scenarios: [fakeScenario('1')] });
    const sink = createMemorySink();

    await runScenarioUpdate(
      '1',
      { json: true, steps: '-' },
      sink,
      envFor(api),
      stdinOf(
        JSON.stringify([
          { action: 'click new game' },
          { action: 'confirm the story scene appears', case_id: 42 },
          { action: 'a brand new step' },
        ]),
      ),
    );

    const payload = sink.lastJson<ScenarioPayload>();
    expect(payload.steps).toHaveLength(3);
    // 같은 자리에 같은 action·caseId 로 남은 스텝은 라벨을 이어받는다.
    expect(payload.steps[1]).toMatchObject({ caseId: 42, expectedPassed: true });
    // 새로 끼워 넣은 스텝은 라벨이 없다.
    expect(payload.steps[2]?.expectedPassed).toBeNull();
  });

  it('does not read standard input when --steps is omitted entirely', async () => {
    api = await startFakeScenarioServer({ scenarios: [fakeScenario('1')] });
    const sink = createMemorySink();

    // `interactiveStdin` 은 `on`(스트림 읽기)을 아예 정의하지 않는다 — 이 호출이 그것을
    // 부르면 TypeError 로 즉시 드러난다.
    await runScenarioUpdate(
      '1',
      { json: true, description: 'Only the description changes.', steps: undefined },
      sink,
      envFor(api),
      interactiveStdin(),
    );

    const payload = sink.lastJson<ScenarioPayload>();
    expect(payload.description).toBe('Only the description changes.');
    expect(payload.steps).toHaveLength(2);
  });

  it('refuses when nothing is given to update', async () => {
    api = await startFakeScenarioServer({ scenarios: [fakeScenario('1')] });
    const sink = createMemorySink();

    await expect(
      runScenarioUpdate(
        '1',
        { json: true, steps: undefined },
        sink,
        envFor(api),
        interactiveStdin(),
      ),
    ).rejects.toBeInstanceOf(UsageError);
  });
});

describe('scenario delete', () => {
  it('deletes a scenario with no QA history outright', async () => {
    api = await startFakeScenarioServer({
      scenarios: [fakeScenario('1', { hasQaHistory: false })],
    });
    const sink = createMemorySink();

    await runScenarioDelete('1', { json: true, force: false }, sink, envFor(api));

    const payload = sink.lastJson<ScenarioDeletePayload>();
    expect(Object.keys(payload).sort()).toEqual(DELETE_KEYS);
    expect(payload).toEqual({ scenarioId: '1', deleted: true, forced: false });
    expect(api.scenarios.find((item) => item.id === '1')).toBeUndefined();
  });

  it('keeps a scenario with QA history unless --force is given', async () => {
    api = await startFakeScenarioServer({ scenarios: [fakeScenario('1', { hasQaHistory: true })] });
    const sink = createMemorySink();

    const code = await runCli(
      ['scenario', 'delete', '1', '--api-url', api.baseUrl, '--json'],
      sink,
      envFor(api),
    );

    expect(code).toBe(EXIT_FAILURE);
    expect(sink.lastJson<ErrorEnvelope>().error.code).toBe('scenario_has_qa_history');
    expect(api.scenarios.find((item) => item.id === '1')).toBeDefined();

    const sink2 = createMemorySink();
    await runScenarioDelete('1', { json: true, force: true }, sink2, envFor(api));
    expect(sink2.lastJson<ScenarioDeletePayload>()).toMatchObject({ deleted: true, forced: true });
    expect(api.scenarios.find((item) => item.id === '1')).toBeUndefined();
  });
});

describe('scenario approve', () => {
  it('accepts the server\'s plain-text "승인 완료" body as success', async () => {
    api = await startFakeScenarioServer({ scenarios: [fakeScenario('1')] });
    const sink = createMemorySink();

    await runScenarioApprove('1', { json: true }, sink, envFor(api));

    const payload = sink.lastJson<ScenarioApprovePayload>();
    expect(Object.keys(payload).sort()).toEqual(APPROVE_KEYS);
    expect(payload).toEqual({ scenarioId: '1', approved: true });
    expect(api.approveCalls).toEqual(['1']);
  });

  it('says so, in human output, that approval is not an execution gate', async () => {
    api = await startFakeScenarioServer({ scenarios: [fakeScenario('1')] });
    const sink = createMemorySink();

    await runScenarioApprove('1', { json: false }, sink, envFor(api));

    expect(sink.stdout.join('\n')).toContain('does not track approval as a gate');
  });

  it('reports a missing scenario as scenario_not_found', async () => {
    api = await startFakeScenarioServer();
    const sink = createMemorySink();

    await expect(
      runScenarioApprove('999', { json: true }, sink, envFor(api)),
    ).rejects.toMatchObject({ code: 'scenario_not_found' });
  });
});

describe('scenario expected-labels', () => {
  it('sets labels by step number without touching the body', async () => {
    api = await startFakeScenarioServer({ scenarios: [fakeScenario('1')] });
    const sink = createMemorySink();

    await runScenarioExpectedLabels(
      '1',
      { json: true, labels: undefined },
      sink,
      envFor(api),
      stdinOf(JSON.stringify([{ step: 1, expected_passed: false }])),
    );

    const payload = sink.lastJson<ScenarioPayload>();
    expect(payload.steps[0]).toMatchObject({ expectedPassed: false });
    expect(payload.steps[1]).toMatchObject({ expectedPassed: true });
    expect(payload.title).toBe('New game story');
  });

  it('refuses a label entry missing expected_passed, naming the position', async () => {
    api = await startFakeScenarioServer({ scenarios: [fakeScenario('1')] });
    const sink = createMemorySink();

    await expectCliFailure(
      runScenarioExpectedLabels(
        '1',
        { json: true, labels: undefined },
        sink,
        envFor(api),
        stdinOf(JSON.stringify([{ step: 1 }])),
      ),
      'scenario_invalid_labels',
      /\[0\] is missing "expected_passed"/,
    );
  });

  it('refuses a non-positive step number', async () => {
    api = await startFakeScenarioServer({ scenarios: [fakeScenario('1')] });
    const sink = createMemorySink();

    await expect(
      runScenarioExpectedLabels(
        '1',
        { json: true, labels: undefined },
        sink,
        envFor(api),
        stdinOf(JSON.stringify([{ step: 0, expected_passed: true }])),
      ),
    ).rejects.toMatchObject({ code: 'scenario_invalid_labels' });
  });
});

describe('scenario --json availability', () => {
  it('every scenario command accepts --json', async () => {
    const program = await import('../src/run.js');
    const sink = createMemorySink();
    const code = await program.runCli(['scenario', '--help'], sink, {});
    expect(code).toBe(EXIT_OK);
    for (const sub of [
      'list',
      'create',
      'show',
      'update',
      'delete',
      'approve',
      'expected-labels',
    ]) {
      const helpSink = createMemorySink();
      const helpCode = await program.runCli(['scenario', sub, '--help'], helpSink, {});
      expect(helpCode).toBe(EXIT_OK);
      expect(helpSink.stdout.join('\n')).toContain('--json');
    }
  });
});
