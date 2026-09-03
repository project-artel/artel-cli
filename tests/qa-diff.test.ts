import { afterEach, describe, expect, it } from 'vitest';

import { runQaDiff } from '../src/commands/qa/diff.js';
import type { QaDiffPayload } from '../src/output/contract.js';
import { EXIT_USAGE, runCli } from '../src/run.js';
import { createMemorySink } from './helpers.js';
import { fakeQaRun, startFakeQaServer, type FakeQaServer } from './qa-helpers.js';

/** `QaRunConfigStatsCell` 한 줄. 축 넷을 뺀 나머지는 전부 0 으로 두고 필요한 것만 덮어쓴다. */
function cell(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    model: null,
    reasoningEffort: null,
    promptVersion: null,
    agentArch: null,
    runs: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    active: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    costUsd: null,
    llmCalls: 0,
    avgCompletedDurationMs: null,
    verdictKnown: 0,
    stepsTotal: 0,
    stepsPassed: 0,
    casesTotal: 0,
    casesPassed: 0,
    scoredRuns: 0,
    correctPass: 0,
    falseAlarm: 0,
    miss: 0,
    correctFail: 0,
    unreported: 0,
    ...overrides,
  };
}

const STATS = {
  projectId: '1',
  from: '2026-08-04T00:00:00Z',
  to: '2026-09-03T00:00:00Z',
  total: cell({ runs: 30 }),
  cells: [
    cell({
      model: 'old',
      promptVersion: 'v15',
      reasoningEffort: 'low',
      agentArch: 'v2-tool-loop',
      runs: 10,
      completed: 10,
      stepsTotal: 100,
      stepsPassed: 60,
      verdictKnown: 10,
      scoredRuns: 10,
      correctPass: 40,
      miss: 20,
      avgCompletedDurationMs: 1_000,
      costUsd: 1.5,
    }),
    // 같은 model 의 다른 reasoning effort. `model=new` 만 고르면 아래 둘이 함께 합쳐진다.
    cell({
      model: 'new',
      promptVersion: 'v15',
      reasoningEffort: 'low',
      agentArch: 'v2-tool-loop',
      runs: 4,
      completed: 4,
      stepsTotal: 40,
      stepsPassed: 36,
      verdictKnown: 4,
      avgCompletedDurationMs: 2_000,
      costUsd: 1,
    }),
    cell({
      model: 'new',
      promptVersion: 'v15',
      reasoningEffort: 'high',
      agentArch: 'v2-tool-loop',
      runs: 6,
      completed: 6,
      stepsTotal: 60,
      stepsPassed: 54,
      verdictKnown: 6,
      avgCompletedDurationMs: 5_000,
      costUsd: 2,
    }),
    // 축이 미상인 셀. ARTEL-239 이전에 끝난 런들이고, 축을 짚은 선택에는 걸리면 안 된다.
    cell({ runs: 10, failed: 10 }),
  ],
  truncated: false,
  cellLimit: 200,
};

let api: FakeQaServer;

afterEach(async () => {
  await api.close();
});

function envFor(server: FakeQaServer): NodeJS.ProcessEnv {
  return { ARTEL_TOKEN: 'artel_test_token', ARTEL_API_BASE_URL: server.baseUrl };
}

describe('qa diff', () => {
  it('sums the cells one selector covers and subtracts the two sums', async () => {
    api = await startFakeQaServer({ run: fakeQaRun(), stats: STATS });

    const sink = createMemorySink();
    await runQaDiff('model=old', 'model=new', { json: true, project: '1' }, sink, envFor(api));

    const payload = sink.lastJson<QaDiffPayload>();
    expect(Object.keys(payload).sort()).toEqual([
      'base',
      'difference',
      'from',
      'projectId',
      'target',
      'to',
      'truncated',
    ]);
    expect(payload.base).toMatchObject({ cells: 1, selector: { model: 'old' } });
    expect(payload.target.cells).toBe(2);
    expect(payload.target.metrics).toMatchObject({
      runs: 10,
      stepsTotal: 100,
      stepsPassed: 90,
      costUsd: 3,
    });
    expect(payload.difference).toMatchObject({
      runs: 0,
      stepsPassed: 30,
      stepsTotal: 0,
      correctPass: -40,
      miss: -20,
      costUsd: 1.5,
    });
  });

  it('weights the duration average by the runs each cell averaged over', async () => {
    api = await startFakeQaServer({ run: fakeQaRun(), stats: STATS });

    const sink = createMemorySink();
    await runQaDiff('model=old', 'model=new', { json: true }, sink, envFor(api));

    // (2000*4 + 5000*6) / 10 = 3800. 두 평균의 산술평균 3500 이 아니다.
    expect(sink.lastJson<QaDiffPayload>().target.metrics.avgCompletedDurationMs).toBe(3_800);
    expect(sink.lastJson<QaDiffPayload>().difference.avgCompletedDurationMs).toBe(2_800);
  });

  it('leaves an axis out of the match when the selector does not name it', async () => {
    api = await startFakeQaServer({ run: fakeQaRun(), stats: STATS });

    const sink = createMemorySink();
    await runQaDiff(
      'model=new,reasoningEffort=low',
      'model=new,reasoningEffort=high',
      { json: true },
      sink,
      envFor(api),
    );

    const payload = sink.lastJson<QaDiffPayload>();
    expect(payload.base.cells).toBe(1);
    expect(payload.target.cells).toBe(1);
    expect(payload.difference.runs).toBe(2);
  });

  it('never matches the cell whose axes are unknown', async () => {
    api = await startFakeQaServer({ run: fakeQaRun(), stats: STATS });

    const sink = createMemorySink();
    await runQaDiff('model=old', 'model=missing', { json: true }, sink, envFor(api));

    const payload = sink.lastJson<QaDiffPayload>();
    expect(payload.target.cells).toBe(0);
    expect(payload.target.metrics.runs).toBe(0);
  });

  it('calls the cost unknown when any matched cell priced nothing', async () => {
    api = await startFakeQaServer({
      run: fakeQaRun(),
      stats: {
        ...STATS,
        cells: [
          cell({ model: 'old', runs: 1, costUsd: 2 }),
          cell({ model: 'new', promptVersion: 'v15', runs: 1, costUsd: 1 }),
          cell({ model: 'new', promptVersion: 'v16', runs: 1, costUsd: null }),
        ],
      },
    });

    const sink = createMemorySink();
    await runQaDiff('model=old', 'model=new', { json: true }, sink, envFor(api));

    const payload = sink.lastJson<QaDiffPayload>();
    expect(payload.target.metrics.costUsd).toBeNull();
    expect(payload.difference.costUsd).toBeNull();
  });

  it('rejects a selector that names no axis, or an axis it does not know', async () => {
    api = await startFakeQaServer({ run: fakeQaRun(), stats: STATS });

    const sink = createMemorySink();
    expect(
      await runCli(['qa', 'diff', '', 'model=new', '--api-url', api.baseUrl], sink, envFor(api)),
    ).toBe(EXIT_USAGE);
    expect(
      await runCli(
        ['qa', 'diff', 'prompt=v15', 'model=new', '--api-url', api.baseUrl],
        sink,
        envFor(api),
      ),
    ).toBe(EXIT_USAGE);
    expect(sink.stderr.join('\n')).toContain('promptVersion');
  });

  it('prints the denominator next to every rate it derives', async () => {
    api = await startFakeQaServer({ run: fakeQaRun(), stats: STATS });

    const sink = createMemorySink();
    const code = await runCli(
      ['qa', 'diff', 'model=old', 'model=new', '--api-url', api.baseUrl],
      sink,
      envFor(api),
    );

    expect(code).toBe(0);
    const output = sink.stdout.join('\n');
    expect(output).toContain('60.0% (60/100)');
    expect(output).toContain('90.0% (90/100)');
    expect(output).toContain('+30.0pp');
  });
});
