import { afterEach, describe, expect, it } from 'vitest';

import { runList } from '../src/commands/run/list.js';
import { runShow } from '../src/commands/run/show.js';
import { runUpdate } from '../src/commands/run/update.js';
import type { ErrorEnvelope, TestRunListPayload, TestRunPayload } from '../src/output/contract.js';
import { EXIT_FAILURE, EXIT_OK, runCli } from '../src/run.js';
import { createMemorySink } from './helpers.js';
import { fakeTestRun, startFakeTestRunServer, type FakeTestRunServer } from './test-run-helpers.js';

const TEST_RUN_KEYS = ['createdAt', 'description', 'name', 'projectId', 'runId'];

let api: FakeTestRunServer;

afterEach(async () => {
  await api.close();
});

function envFor(server: FakeTestRunServer): NodeJS.ProcessEnv {
  return { ARTEL_TOKEN: 'artel_test_token', ARTEL_API_BASE_URL: server.baseUrl };
}

describe('run list', () => {
  it('lists only the runs of the given project, and emits exactly its contracted keys', async () => {
    api = await startFakeTestRunServer({
      runs: [
        fakeTestRun({ id: '1', projectId: '1', name: 'benchmark v1' }),
        fakeTestRun({ id: '2', projectId: '1', name: 'benchmark v2' }),
        fakeTestRun({ id: '3', projectId: '2', name: 'other project run' }),
      ],
    });

    const sink = createMemorySink();
    await runList({ json: true, project: '1' }, sink, envFor(api));

    const payload = sink.lastJson<TestRunListPayload>();
    expect(payload.items.map((run) => run.runId).sort()).toEqual(['1', '2']);
    expect(Object.keys(payload.items[0] ?? {}).sort()).toEqual(TEST_RUN_KEYS);
  });

  it('prints a human-readable line per run', async () => {
    api = await startFakeTestRunServer({
      runs: [fakeTestRun({ id: '1', projectId: '1', name: 'benchmark v1' })],
    });

    const sink = createMemorySink();
    const code = await runCli(
      ['run', 'list', '--project', '1', '--api-url', api.baseUrl],
      sink,
      envFor(api),
    );

    expect(code).toBe(EXIT_OK);
    expect(sink.stdout.join('\n')).toContain('benchmark v1');
  });

  it('reports an empty project with an empty list, not an error', async () => {
    api = await startFakeTestRunServer({ runs: [] });

    const sink = createMemorySink();
    await runList({ json: true, project: '9' }, sink, envFor(api));

    expect(sink.lastJson<TestRunListPayload>()).toEqual({ items: [] });
  });
});

describe('run create', () => {
  it('creates a run empty of scenarios and reports exactly its contracted keys', async () => {
    api = await startFakeTestRunServer({});

    const sink = createMemorySink();
    const code = await runCli(
      [
        'run',
        'create',
        '--project',
        '1',
        '--name',
        'benchmark v1',
        '--description',
        'the save-less fresh install run',
        '--api-url',
        api.baseUrl,
        '--json',
      ],
      sink,
      envFor(api),
    );

    expect(code).toBe(EXIT_OK);
    const payload = sink.lastJson<TestRunPayload>();
    expect(Object.keys(payload).sort()).toEqual(TEST_RUN_KEYS);
    expect(payload).toMatchObject({
      projectId: '1',
      name: 'benchmark v1',
      description: 'the save-less fresh install run',
    });
    expect(api.createBodies).toEqual([
      { name: 'benchmark v1', description: 'the save-less fresh install run' },
    ]);
  });

  it('surfaces the server-invalid-request code, e.g. an empty name', async () => {
    api = await startFakeTestRunServer({
      createFailsWith: {
        status: 400,
        body: '{"code":"invalid_request","message":"name is required"}',
      },
    });

    const sink = createMemorySink();
    const code = await runCli(
      ['run', 'create', '--project', '1', '--name', ' ', '--api-url', api.baseUrl, '--json'],
      sink,
      envFor(api),
    );

    expect(code).toBe(EXIT_FAILURE);
    const envelope = sink.lastJson<ErrorEnvelope>();
    expect(envelope.error.code).toBe('run_invalid_request');
    expect(envelope.error.message).toBe('name is required');
  });
});

describe('run show', () => {
  it('reads one run', async () => {
    api = await startFakeTestRunServer({
      runs: [fakeTestRun({ id: '4', projectId: '1', name: 'benchmark v1' })],
    });

    const sink = createMemorySink();
    await runShow('4', { json: true, project: '1' }, sink, envFor(api));

    expect(sink.lastJson<TestRunPayload>()).toMatchObject({ runId: '4', name: 'benchmark v1' });
  });

  it('reports run_not_found for a run that does not exist', async () => {
    api = await startFakeTestRunServer({});

    const sink = createMemorySink();
    const code = await runCli(
      ['run', 'show', '999', '--project', '1', '--api-url', api.baseUrl, '--json'],
      sink,
      envFor(api),
    );

    expect(code).toBe(EXIT_FAILURE);
    expect(sink.lastJson<ErrorEnvelope>().error.code).toBe('run_not_found');
  });
});

describe('run update', () => {
  it('changes name and description without touching the scenario binding', async () => {
    api = await startFakeTestRunServer({
      runs: [fakeTestRun({ id: '4', projectId: '1', name: 'old name', description: 'old' })],
      scenarios: { '4': ['10', '11'] },
    });

    const sink = createMemorySink();
    await runUpdate('4', { json: true, project: '1', name: 'new name' }, sink, envFor(api));

    expect(sink.lastJson<TestRunPayload>()).toMatchObject({
      runId: '4',
      name: 'new name',
      description: 'old',
    });
    expect(api.scenarios['4']).toEqual(['10', '11']);
  });
});
