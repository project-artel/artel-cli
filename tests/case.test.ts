import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import { runCaseCreate } from '../src/commands/case/create.js';
import { runCaseDelete } from '../src/commands/case/delete.js';
import { runCaseList } from '../src/commands/case/list.js';
import { runCaseShow } from '../src/commands/case/show.js';
import { runCaseUpdate } from '../src/commands/case/update.js';
import type {
  CaseCreateBatchPayload,
  CaseDeletePayload,
  CaseListPayload,
  ErrorEnvelope,
  TestCaseDetailPayload,
  TestCasePayload,
} from '../src/output/contract.js';
import { EXIT_FAILURE, EXIT_OK, runCli } from '../src/run.js';
import { createMemorySink } from './helpers.js';
import { fakeTestCase, startFakeCaseServer, type FakeCaseServer } from './case-helpers.js';

/** `case list`/`case create`(단건)/`case update` 가 내는 필드 집합. 첫 릴리스부터 공개 계약이다. */
const TEST_CASE_KEYS = [
  'createdAt',
  'expectedValue',
  'id',
  'lastVerifiedBuildId',
  'precondition',
  'projectId',
  'scene',
  'status',
  'step',
  'verificationStatus',
];

const TEST_CASE_DETAIL_KEYS = [...TEST_CASE_KEYS, 'evidenceGaps'].sort();

let api: FakeCaseServer;

afterEach(async () => {
  await api.close();
});

function envFor(server: FakeCaseServer): NodeJS.ProcessEnv {
  return { ARTEL_TOKEN: 'artel_test_token', ARTEL_API_BASE_URL: server.baseUrl };
}

function stdinOf(text: string): NodeJS.ReadableStream {
  return Readable.from([text]);
}

describe('case list', () => {
  it('lists a member project’s cases with exactly the contracted keys', async () => {
    api = await startFakeCaseServer({
      memberProjectIds: ['1'],
      items: [fakeTestCase({ id: '1', projectId: '1' }), fakeTestCase({ id: '2', projectId: '1' })],
    });
    const sink = createMemorySink();

    await runCaseList({ json: true, project: '1' }, sink, envFor(api));

    const payload = sink.lastJson<CaseListPayload>();
    expect(payload.items).toHaveLength(2);
    expect(Object.keys(payload.items[0] ?? {}).sort()).toEqual(TEST_CASE_KEYS);
  });

  it('reports an empty list for a project the caller cannot see, not an error', async () => {
    api = await startFakeCaseServer({
      memberProjectIds: ['1'],
      items: [fakeTestCase({ id: '1', projectId: '1' })],
    });
    const sink = createMemorySink();

    await runCaseList({ json: true, project: '2' }, sink, envFor(api));

    expect(sink.lastJson<CaseListPayload>().items).toEqual([]);
  });

  it('prints a human-readable summary line', async () => {
    api = await startFakeCaseServer({
      memberProjectIds: ['1'],
      items: [fakeTestCase({ id: '1', projectId: '1', scene: 'Title Screen' })],
    });
    const sink = createMemorySink();

    const code = await runCli(
      ['case', 'list', '--project', '1', '--api-url', api.baseUrl],
      sink,
      envFor(api),
    );

    expect(code).toBe(EXIT_OK);
    expect(sink.stdout.join('\n')).toContain('1 test case(s) in project 1.');
  });
});

describe('case show', () => {
  it('reads one case, with evidenceGaps and exactly the contracted keys', async () => {
    api = await startFakeCaseServer({
      memberProjectIds: ['1'],
      items: [
        fakeTestCase({
          id: '5',
          projectId: '1',
          evidenceGaps: ['no_screenshot_for_step'],
        }),
      ],
    });
    const sink = createMemorySink();

    await runCaseShow('5', { json: true, project: '1' }, sink, envFor(api));

    const payload = sink.lastJson<TestCaseDetailPayload>();
    expect(Object.keys(payload).sort()).toEqual(TEST_CASE_DETAIL_KEYS);
    expect(payload.evidenceGaps).toEqual(['no_screenshot_for_step']);
  });

  it('reports case_not_found for a case that does not exist', async () => {
    api = await startFakeCaseServer({ memberProjectIds: ['1'] });
    const sink = createMemorySink();

    const code = await runCli(
      ['case', 'show', '999', '--project', '1', '--api-url', api.baseUrl, '--json'],
      sink,
      envFor(api),
    );

    expect(code).toBe(EXIT_FAILURE);
    expect(sink.lastJson<ErrorEnvelope>().error.code).toBe('case_not_found');
  });

  it('reports case_not_found for a project the caller cannot see', async () => {
    api = await startFakeCaseServer({
      memberProjectIds: ['1'],
      items: [fakeTestCase({ id: '5', projectId: '1' })],
    });
    const sink = createMemorySink();

    const code = await runCli(
      ['case', 'show', '5', '--project', '2', '--api-url', api.baseUrl, '--json'],
      sink,
      envFor(api),
    );

    expect(code).toBe(EXIT_FAILURE);
    expect(sink.lastJson<ErrorEnvelope>().error.code).toBe('case_not_found');
  });
});

describe('case create — one', () => {
  it('creates a case from --file, echoing exactly the server’s fields', async () => {
    api = await startFakeCaseServer({ memberProjectIds: ['1'] });
    const sink = createMemorySink();
    const body = JSON.stringify({
      scene: 'Title Screen',
      step: 'Tap "New Game"',
      precondition: 'The player has no save file.',
      expectedValue: 'The naming screen appears.',
    });
    const path = await writeTempJson(body);

    const code = await runCaseCreate({ json: true, project: '1', file: path }, sink, envFor(api));

    expect(code).toBe(EXIT_OK);
    const payload = sink.lastJson<TestCasePayload>();
    expect(Object.keys(payload).sort()).toEqual(TEST_CASE_KEYS);
    expect(payload).toMatchObject({
      projectId: '1',
      scene: 'Title Screen',
      step: 'Tap "New Game"',
      precondition: 'The player has no save file.',
      expectedValue: 'The naming screen appears.',
      verificationStatus: 'DRAFT',
    });
  });

  it('creates a case from standard input when --file is omitted', async () => {
    api = await startFakeCaseServer({ memberProjectIds: ['1'] });
    const sink = createMemorySink();
    const body = JSON.stringify({
      scene: 'Title Screen',
      step: 'Tap "New Game"',
      expectedValue: 'The naming screen appears.',
    });

    const code = await runCaseCreate(
      { json: true, project: '1' },
      sink,
      envFor(api),
      undefined,
      stdinOf(body),
    );

    expect(code).toBe(EXIT_OK);
    expect(api.requests.some((request) => request.method === 'POST')).toBe(true);
  });

  it('reports case_invalid_request for a missing required field', async () => {
    api = await startFakeCaseServer({ memberProjectIds: ['1'] });
    const sink = createMemorySink();

    await expect(
      runCaseCreate(
        { json: true, project: '1' },
        sink,
        envFor(api),
        undefined,
        stdinOf(JSON.stringify({ scene: 'Title Screen' })),
      ),
    ).rejects.toMatchObject({ code: 'case_invalid_request' });
  });

  it('reports case_not_found for a project the caller cannot create in', async () => {
    api = await startFakeCaseServer({ memberProjectIds: [] });
    const sink = createMemorySink();

    await expect(
      runCaseCreate(
        { json: true, project: '9' },
        sink,
        envFor(api),
        undefined,
        stdinOf(JSON.stringify({ scene: 'a', step: 'b', expectedValue: 'c' })),
      ),
    ).rejects.toMatchObject({ code: 'case_not_found' });
  });

  it('reports case_invalid_body for text that is not JSON', async () => {
    api = await startFakeCaseServer({ memberProjectIds: ['1'] });
    const sink = createMemorySink();

    await expect(
      runCaseCreate(
        { json: true, project: '1' },
        sink,
        envFor(api),
        undefined,
        stdinOf('not json'),
      ),
    ).rejects.toMatchObject({ code: 'case_invalid_body' });
  });
});

describe('case create — many', () => {
  it('creates every case in the array and exits 0 when all succeed', async () => {
    api = await startFakeCaseServer({ memberProjectIds: ['1'] });
    const sink = createMemorySink();
    const body = JSON.stringify([
      { scene: 'Title Screen', step: 'Tap "New Game"', expectedValue: 'a' },
      { scene: 'Title Screen', step: 'Tap "Continue"', expectedValue: 'b' },
      { scene: 'Title Screen', step: 'Tap "Options"', expectedValue: 'c' },
    ]);

    const code = await runCaseCreate(
      { json: true, project: '1' },
      sink,
      envFor(api),
      undefined,
      stdinOf(body),
    );

    expect(code).toBe(EXIT_OK);
    const payload = sink.lastJson<CaseCreateBatchPayload>();
    expect(payload).toMatchObject({ projectId: '1', requested: 3, created: 3, failed: 0 });
    expect(
      payload.results.every((result) => result.created !== null && result.error === null),
    ).toBe(true);
    expect(api.items()).toHaveLength(3);
  });

  it('keeps going past a failing item and reports it without aborting the rest', async () => {
    api = await startFakeCaseServer({ memberProjectIds: ['1'] });
    const sink = createMemorySink();
    const body = JSON.stringify([
      { scene: 'Title Screen', step: 'Tap "New Game"', expectedValue: 'a' },
      { scene: 'Title Screen' }, // step, expectedValue 없음 → 400
      { scene: 'Title Screen', step: 'Tap "Options"', expectedValue: 'c' },
    ]);

    const code = await runCaseCreate(
      { json: true, project: '1' },
      sink,
      envFor(api),
      undefined,
      stdinOf(body),
    );

    expect(code).toBe(EXIT_FAILURE);
    const payload = sink.lastJson<CaseCreateBatchPayload>();
    expect(payload).toMatchObject({ requested: 3, created: 2, failed: 1 });
    expect(payload.results[0]?.created).not.toBeNull();
    expect(payload.results[1]?.created).toBeNull();
    expect(payload.results[1]?.error?.code).toBe('case_invalid_request');
    expect(payload.results[2]?.created).not.toBeNull();
    // 실패한 항목 다음도 계속 만들어졌다 — 전부 서버에 남아 있다.
    expect(api.items()).toHaveLength(2);
  });

  it('rejects an empty array as case_invalid_body', async () => {
    api = await startFakeCaseServer({ memberProjectIds: ['1'] });
    const sink = createMemorySink();

    await expect(
      runCaseCreate({ json: true, project: '1' }, sink, envFor(api), undefined, stdinOf('[]')),
    ).rejects.toMatchObject({ code: 'case_invalid_body' });
  });
});

describe('case update', () => {
  it('changes only the given fields', async () => {
    api = await startFakeCaseServer({
      memberProjectIds: ['1'],
      items: [
        fakeTestCase({
          id: '5',
          projectId: '1',
          scene: 'Title Screen',
          step: 'old step',
          verificationStatus: 'DRAFT',
        }),
      ],
    });
    const sink = createMemorySink();

    await runCaseUpdate(
      '5',
      { json: true, project: '1' },
      sink,
      envFor(api),
      undefined,
      stdinOf(JSON.stringify({ verificationStatus: 'VERIFIED' })),
    );

    const payload = sink.lastJson<TestCasePayload>();
    expect(payload).toMatchObject({
      id: '5',
      scene: 'Title Screen',
      step: 'old step',
      verificationStatus: 'VERIFIED',
    });
  });

  it('reports case_invalid_request for an unknown verificationStatus', async () => {
    api = await startFakeCaseServer({
      memberProjectIds: ['1'],
      items: [fakeTestCase({ id: '5', projectId: '1' })],
    });
    const sink = createMemorySink();

    await expect(
      runCaseUpdate(
        '5',
        { json: true, project: '1' },
        sink,
        envFor(api),
        undefined,
        stdinOf(JSON.stringify({ verificationStatus: 'NOPE' })),
      ),
    ).rejects.toMatchObject({ code: 'case_invalid_request' });
  });
});

describe('case delete', () => {
  it('deletes the case and reports it', async () => {
    api = await startFakeCaseServer({
      memberProjectIds: ['1'],
      items: [fakeTestCase({ id: '5', projectId: '1' })],
    });
    const sink = createMemorySink();

    await runCaseDelete('5', { json: true, project: '1' }, sink, envFor(api));

    expect(sink.lastJson<CaseDeletePayload>()).toEqual({ id: '5', projectId: '1', deleted: true });
    expect(api.items()).toHaveLength(0);
  });

  it('reports case_not_found for a case that is already gone', async () => {
    api = await startFakeCaseServer({ memberProjectIds: ['1'] });
    const sink = createMemorySink();

    const code = await runCli(
      ['case', 'delete', '404', '--project', '1', '--api-url', api.baseUrl, '--json'],
      sink,
      envFor(api),
    );

    expect(code).toBe(EXIT_FAILURE);
    expect(sink.lastJson<ErrorEnvelope>().error.code).toBe('case_not_found');
  });
});

async function writeTempJson(text: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'artel-case-test-'));
  const file = path.join(dir, 'body.json');
  await fs.writeFile(file, text, 'utf8');
  return file;
}
