import { afterEach, describe, expect, it } from 'vitest';

import { runDelete } from '../src/commands/run/delete.js';
import type { ErrorEnvelope, TestRunDeletePayload } from '../src/output/contract.js';
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

describe('run delete without --yes', () => {
  it('shows the deletion preview and deletes nothing', async () => {
    api = await startFakeTestRunServer({
      runs: [fakeTestRun({ id: '4', projectId: '1' })],
      deletionPreviews: {
        '4': { scenarioCount: 5, removableScenarioCount: 3, keptForQaHistoryCount: 1 },
      },
    });

    const sink = createMemorySink();
    await runDelete(
      '4',
      { json: true, project: '1', dropScenarios: false, yes: false },
      sink,
      envFor(api),
    );

    expect(sink.lastJson<TestRunDeletePayload>()).toEqual({
      runId: '4',
      dropScenarios: false,
      confirmed: false,
      preview: { scenarioCount: 5, removableScenarioCount: 3, keptForQaHistoryCount: 1 },
      deletedScenarioCount: null,
      deletedKeptForQaHistoryCount: null,
    });
    expect(api.deleteCalls).toEqual([]);
    expect(api.runs.some((run) => run.id === '4')).toBe(true);
  });

  it('tells a human what would be taken down and how to confirm', async () => {
    api = await startFakeTestRunServer({
      runs: [fakeTestRun({ id: '4', projectId: '1' })],
      deletionPreviews: {
        '4': { scenarioCount: 5, removableScenarioCount: 3, keptForQaHistoryCount: 1 },
      },
    });

    const sink = createMemorySink();
    const code = await runCli(
      ['run', 'delete', '4', '--project', '1', '--api-url', api.baseUrl],
      sink,
      envFor(api),
    );

    expect(code).toBe(EXIT_OK);
    const text = sink.stdout.join('\n');
    expect(text).toContain('Not deleted');
    expect(text).toContain('--yes');
    expect(api.deleteCalls).toEqual([]);
  });

  it('fails with run_not_found when the run does not exist, before ever calling delete', async () => {
    api = await startFakeTestRunServer({});

    const sink = createMemorySink();
    const code = await runCli(
      ['run', 'delete', '999', '--project', '1', '--api-url', api.baseUrl, '--json'],
      sink,
      envFor(api),
    );

    expect(code).toBe(EXIT_FAILURE);
    expect(sink.lastJson<ErrorEnvelope>().error.code).toBe('run_not_found');
    expect(api.deleteCalls).toEqual([]);
  });
});

describe('run delete --yes', () => {
  it('deletes and reports the actual result, leaving scenarios in place by default', async () => {
    api = await startFakeTestRunServer({
      runs: [fakeTestRun({ id: '4', projectId: '1' })],
      scenarios: { '4': ['10', '11'] },
      deletionPreviews: {
        '4': { scenarioCount: 2, removableScenarioCount: 2, keptForQaHistoryCount: 0 },
      },
    });

    const sink = createMemorySink();
    const code = await runCli(
      ['run', 'delete', '4', '--project', '1', '--yes', '--api-url', api.baseUrl, '--json'],
      sink,
      envFor(api),
    );

    expect(code).toBe(EXIT_OK);
    expect(sink.lastJson<TestRunDeletePayload>()).toEqual({
      runId: '4',
      dropScenarios: false,
      confirmed: true,
      preview: { scenarioCount: 2, removableScenarioCount: 2, keptForQaHistoryCount: 0 },
      deletedScenarioCount: 0,
      deletedKeptForQaHistoryCount: 0,
    });
    expect(api.deleteCalls).toEqual([{ runId: '4', dropScenarios: 'false' }]);
    expect(api.runs.some((run) => run.id === '4')).toBe(false);
  });

  it('with --drop-scenarios, reports the scenarios actually removed with it', async () => {
    api = await startFakeTestRunServer({
      runs: [fakeTestRun({ id: '4', projectId: '1' })],
      scenarios: { '4': ['10', '11'] },
      deletionPreviews: {
        '4': { scenarioCount: 2, removableScenarioCount: 2, keptForQaHistoryCount: 0 },
      },
    });

    const sink = createMemorySink();
    const code = await runCli(
      [
        'run',
        'delete',
        '4',
        '--project',
        '1',
        '--yes',
        '--drop-scenarios',
        '--api-url',
        api.baseUrl,
        '--json',
      ],
      sink,
      envFor(api),
    );

    expect(code).toBe(EXIT_OK);
    const payload = sink.lastJson<TestRunDeletePayload>();
    expect(payload.dropScenarios).toBe(true);
    expect(payload.deletedScenarioCount).toBe(2);
    expect(api.deleteCalls).toEqual([{ runId: '4', dropScenarios: 'true' }]);
  });

  it('refuses with run_has_qa_history when the server rejects for QA history', async () => {
    api = await startFakeTestRunServer({
      runs: [fakeTestRun({ id: '4', projectId: '1' })],
      deleteFailsWith: {
        '4': {
          status: 409,
          body: '{"code":"run_has_qa_history","message":"이 런에는 QA 실행 이력이 2건 있어 삭제할 수 없습니다."}',
        },
      },
    });

    const sink = createMemorySink();
    const code = await runCli(
      ['run', 'delete', '4', '--project', '1', '--yes', '--api-url', api.baseUrl, '--json'],
      sink,
      envFor(api),
    );

    expect(code).toBe(EXIT_FAILURE);
    expect(sink.lastJson<ErrorEnvelope>().error.code).toBe('run_has_qa_history');
  });
});
