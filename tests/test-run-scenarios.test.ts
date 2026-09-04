import { afterEach, describe, expect, it } from 'vitest';

import { runScenarios } from '../src/commands/run/scenarios.js';
import type { ErrorEnvelope, TestRunScenariosPayload } from '../src/output/contract.js';
import { EXIT_FAILURE, EXIT_OK, runCli } from '../src/run.js';
import { createMemorySink } from './helpers.js';
import { fakeTestRun, startFakeTestRunServer, type FakeTestRunServer } from './test-run-helpers.js';

let api: FakeTestRunServer;

afterEach(async () => {
  await api.close();
});

function envFor(server: FakeTestRunServer): NodeJS.ProcessEnv {
  return { ARTEL_TOKEN: 'artel_test_token', ARTEL_API_BASE_URL: server.baseUrl };
}

describe('run scenarios (read)', () => {
  it('reports the binding in run order', async () => {
    api = await startFakeTestRunServer({
      runs: [fakeTestRun({ id: '4', projectId: '1' })],
      scenarios: { '4': ['10', '7', '9'] },
    });

    const sink = createMemorySink();
    await runScenarios('4', { json: true, project: '1' }, sink, envFor(api));

    const payload = sink.lastJson<TestRunScenariosPayload>();
    expect(payload).toEqual({
      runId: '4',
      items: [
        { position: 0, testScenarioId: '10' },
        { position: 1, testScenarioId: '7' },
        { position: 2, testScenarioId: '9' },
      ],
    });
  });
});

describe('run scenarios --set', () => {
  it('replaces the whole binding, order preserved as position', async () => {
    api = await startFakeTestRunServer({
      runs: [fakeTestRun({ id: '4', projectId: '1' })],
      scenarios: { '4': ['10'] },
    });

    const sink = createMemorySink();
    const code = await runCli(
      [
        'run',
        'scenarios',
        '4',
        '--project',
        '1',
        '--set',
        '7,10,9',
        '--api-url',
        api.baseUrl,
        '--json',
      ],
      sink,
      envFor(api),
    );

    expect(code).toBe(EXIT_OK);
    expect(sink.lastJson<TestRunScenariosPayload>()).toEqual({
      runId: '4',
      items: [
        { position: 0, testScenarioId: '7' },
        { position: 1, testScenarioId: '10' },
        { position: 2, testScenarioId: '9' },
      ],
    });
    expect(api.setScenariosBodies).toEqual([
      { runId: '4', body: { scenarioIds: ['7', '10', '9'] } },
    ]);
  });

  it('surfaces the server code for a scenario id it rejects', async () => {
    api = await startFakeTestRunServer({
      runs: [fakeTestRun({ id: '4', projectId: '1' })],
      setScenariosFailsWith: {
        status: 400,
        body: '{"code":"invalid_request","message":"some scenarios were not found"}',
      },
    });

    const sink = createMemorySink();
    const code = await runCli(
      [
        'run',
        'scenarios',
        '4',
        '--project',
        '1',
        '--set',
        '999',
        '--api-url',
        api.baseUrl,
        '--json',
      ],
      sink,
      envFor(api),
    );

    expect(code).toBe(EXIT_FAILURE);
    const envelope = sink.lastJson<ErrorEnvelope>();
    expect(envelope.error.code).toBe('run_invalid_request');
    expect(envelope.error.message).toBe('some scenarios were not found');
  });

  it('clears the binding when --set is given an empty value', async () => {
    api = await startFakeTestRunServer({
      runs: [fakeTestRun({ id: '4', projectId: '1' })],
      scenarios: { '4': ['10', '7'] },
    });

    const sink = createMemorySink();
    await runScenarios('4', { json: true, project: '1', set: [] }, sink, envFor(api));

    expect(sink.lastJson<TestRunScenariosPayload>()).toEqual({ runId: '4', items: [] });
    expect(api.setScenariosBodies).toEqual([{ runId: '4', body: { scenarioIds: [] } }]);
  });
});
