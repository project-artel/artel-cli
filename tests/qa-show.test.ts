import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runQaCancel } from '../src/commands/qa/cancel.js';
import { runQaShow } from '../src/commands/qa/show.js';
import type { ErrorEnvelope, QaCancelPayload, QaRunPayload } from '../src/output/contract.js';
import { EXIT_FAILURE, EXIT_OK, runCli } from '../src/run.js';
import { createMemorySink } from './helpers.js';
import {
  abortedLog,
  fakeQaRun,
  fakeQaTry,
  startFakeQaServer,
  stepLog,
  terminalLog,
  type FakeQaServer,
} from './qa-helpers.js';

const QA_RUN_KEYS = [
  'cases',
  'completedAt',
  'gameInstanceId',
  'issues',
  'runId',
  'startedAt',
  'status',
  'steps',
  'testRunId',
  'tries',
  'verdict',
];

const QA_TRY_KEYS = [
  'agentArch',
  'agentFingerprint',
  'cases',
  'completedAt',
  'model',
  'promptVersion',
  'reasoningEffort',
  'startedAt',
  'status',
  'stepResults',
  'steps',
  'testScenarioId',
  'tryId',
  'verdict',
];

let api: FakeQaServer;

afterEach(async () => {
  await api.close();
});

function envFor(server: FakeQaServer): NodeJS.ProcessEnv {
  return { ARTEL_TOKEN: 'artel_test_token', ARTEL_API_BASE_URL: server.baseUrl };
}

describe('qa show', () => {
  beforeEach(async () => {
    api = await startFakeQaServer({
      run: fakeQaRun({
        status: 'COMPLETED',
        completedAt: '2026-09-03T05:53:10Z',
        tries: [fakeQaTry('4', { status: 'COMPLETED', completedAt: '2026-09-03T05:53:10Z' })],
      }),
      logs: [
        stepLog('4', 1, true, 'clicked new game'),
        stepLog('4', 2, true, 'story scene appeared'),
        terminalLog(
          '4',
          'PASSED',
          { total: 2, passed: 2, failed: 0 },
          { total: 1, passed: 1, failed: 0 },
        ),
      ],
      issues: [
        {
          id: '9',
          qaTryId: '4',
          severity: 'MAJOR',
          title: 'the map button is unreachable',
          status: 'OPEN',
          reportedAt: '2026-09-03T05:53:05Z',
        },
      ],
    });
  });

  it('reads the verdict out of the terminal frame and emits exactly its contracted keys', async () => {
    const sink = createMemorySink();
    await runQaShow('4', { json: true }, sink, envFor(api));

    const payload = sink.lastJson<QaRunPayload>();
    expect(Object.keys(payload).sort()).toEqual(QA_RUN_KEYS);
    expect(Object.keys(payload.tries[0] ?? {}).sort()).toEqual(QA_TRY_KEYS);
    expect(payload).toMatchObject({
      runId: '4',
      status: 'COMPLETED',
      verdict: 'PASSED',
      steps: { total: 2, passed: 2, failed: 0 },
      cases: { total: 1, passed: 1, failed: 0 },
    });
    expect(payload.tries[0]?.reasoningEffort).toBe('high');
    expect(payload.tries[0]?.stepResults).toHaveLength(2);
    expect(payload.issues).toEqual([
      {
        issueId: '9',
        tryId: '4',
        severity: 'MAJOR',
        title: 'the map button is unreachable',
        status: 'OPEN',
        reportedAt: '2026-09-03T05:53:05Z',
      },
    ]);
  });

  it('reports a verdict of its own, and still exits 0', async () => {
    const sink = createMemorySink();
    const code = await runCli(['qa', 'show', '4', '--api-url', api.baseUrl], sink, envFor(api));

    expect(code).toBe(EXIT_OK);
    expect(sink.stdout.join('\n')).toContain('QA run 4 — PASSED (COMPLETED).');
  });
});

describe('qa show with no terminal summary', () => {
  beforeEach(async () => {
    api = await startFakeQaServer({
      run: fakeQaRun({
        status: 'FAILED',
        completedAt: '2026-09-03T06:00:00Z',
        tries: [fakeQaTry('4', { status: 'FAILED', completedAt: '2026-09-03T06:00:00Z' })],
      }),
      logs: [stepLog('4', 1, true, 'clicked new game'), abortedLog('4', 'FAILED')],
    });
  });

  it('calls the verdict unknown rather than failed', async () => {
    const sink = createMemorySink();
    await runQaShow('4', { json: true }, sink, envFor(api));

    const payload = sink.lastJson<QaRunPayload>();
    expect(payload.status).toBe('FAILED');
    expect(payload.verdict).toBeNull();
    expect(payload.steps).toEqual({ total: null, passed: null, failed: null });
  });
});

describe('qa cancel', () => {
  it('stops the run and reports the status it settled on', async () => {
    api = await startFakeQaServer({
      run: fakeQaRun({ status: 'RUNNING', tries: [fakeQaTry('4', { status: 'RUNNING' })] }),
    });

    const sink = createMemorySink();
    await runQaCancel('4', { json: true }, sink, envFor(api));

    expect(sink.lastJson<QaCancelPayload>()).toEqual({
      runId: '4',
      cancelled: true,
      status: 'CANCELLED',
    });
  });

  it('refuses a run that already finished, with the code the server used to say so', async () => {
    api = await startFakeQaServer({
      run: fakeQaRun({ status: 'COMPLETED' }),
      cancelFailsWith: {
        status: 409,
        body: '{"code":"conflict","message":"QA run has already finished"}',
      },
    });

    const sink = createMemorySink();
    const code = await runCli(
      ['qa', 'cancel', '4', '--api-url', api.baseUrl, '--json'],
      sink,
      envFor(api),
    );

    expect(code).toBe(EXIT_FAILURE);
    expect(sink.lastJson<ErrorEnvelope>().error.code).toBe('qa_run_not_active');
  });
});
