import { Readable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { runCaseCreate } from '../src/commands/case/create.js';

import type {
  CaseFolderDeletePayload,
  CaseFolderListPayload,
  CaseListPayload,
  CaseMovePayload,
  ErrorEnvelope,
  TestCaseFolderPayload,
  TestCasePayload,
} from '../src/output/contract.js';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, runCli } from '../src/run.js';
import {
  fakeFolder,
  fakeTestCase,
  startFakeCaseServer,
  type FakeCaseServer,
} from './case-helpers.js';
import { createMemorySink } from './helpers.js';

/** `case folder create`·`case folder update`·`case folder list` 항목의 필드 집합. 공개 계약이다. */
const FOLDER_KEYS = ['contentMapId', 'gameBuildId', 'id', 'name', 'parentId'];
const FOLDER_DELETE_KEYS = ['deleted', 'id', 'projectId'];
const MOVE_KEYS = ['folderId', 'moved', 'projectId', 'requested'];

let api: FakeCaseServer;

afterEach(async () => {
  await api.close();
});

function envFor(server: FakeCaseServer): NodeJS.ProcessEnv {
  return { ARTEL_TOKEN: 'artel_test_token', ARTEL_API_BASE_URL: server.baseUrl };
}

async function cli(
  args: string[],
): Promise<{ code: number; sink: ReturnType<typeof createMemorySink> }> {
  const sink = createMemorySink();
  const code = await runCli([...args, '--api-url', api.baseUrl], sink, envFor(api));
  return { code, sink };
}

describe('case folder list', () => {
  it('lists folders with exactly the contracted keys', async () => {
    api = await startFakeCaseServer({
      memberProjectIds: ['1'],
      folders: [
        fakeFolder({ id: '100', name: 'Combat' }),
        fakeFolder({ id: '101', name: 'v1.2 content map', contentMapId: '7', gameBuildId: '3' }),
      ],
    });

    const { code, sink } = await cli(['case', 'folder', 'list', '--project', '1', '--json']);

    expect(code).toBe(EXIT_OK);
    const payload = sink.lastJson<CaseFolderListPayload>();
    expect(payload.items.map((item) => item.id)).toEqual(['100', '101']);
    expect(Object.keys(payload.items[0] ?? {}).sort()).toEqual(FOLDER_KEYS);
  });

  it('prints nested folders indented under their parent', async () => {
    api = await startFakeCaseServer({
      memberProjectIds: ['1'],
      folders: [
        fakeFolder({ id: '100', name: 'Combat' }),
        fakeFolder({ id: '101', name: 'Boss', parentId: '100' }),
        fakeFolder({ id: '102', name: 'Shop' }),
      ],
    });

    const { sink } = await cli(['case', 'folder', 'list', '--project', '1']);

    expect(sink.stdout).toEqual([
      '3 folder(s) in project 1.',
      '     100  Combat',
      '     101    Boss',
      '     102  Shop',
    ]);
  });

  it('reports case_folder_not_found for a project the caller cannot see', async () => {
    api = await startFakeCaseServer({ memberProjectIds: ['1'] });

    const { code, sink } = await cli(['case', 'folder', 'list', '--project', '2', '--json']);

    expect(code).toBe(EXIT_FAILURE);
    expect(sink.lastJson<ErrorEnvelope>().error.code).toBe('case_folder_not_found');
  });
});

describe('case folder create', () => {
  it('creates a top-level folder when --parent is omitted', async () => {
    api = await startFakeCaseServer({ memberProjectIds: ['1'] });

    const { code, sink } = await cli([
      'case',
      'folder',
      'create',
      '--project',
      '1',
      '--name',
      'Combat',
      '--json',
    ]);

    expect(code).toBe(EXIT_OK);
    const payload = sink.lastJson<TestCaseFolderPayload>();
    expect(Object.keys(payload).sort()).toEqual(FOLDER_KEYS);
    expect(payload).toMatchObject({ name: 'Combat', parentId: null });
    expect(api.requests.at(-1)?.body).toEqual({ name: 'Combat', parentId: null });
  });

  it('creates a folder under --parent', async () => {
    api = await startFakeCaseServer({
      memberProjectIds: ['1'],
      folders: [fakeFolder({ id: '100' })],
    });

    const { sink } = await cli([
      'case',
      'folder',
      'create',
      '--project',
      '1',
      '--name',
      'Boss',
      '--parent',
      '100',
      '--json',
    ]);

    expect(sink.lastJson<TestCaseFolderPayload>().parentId).toBe('100');
  });

  it('reports case_folder_conflict for a duplicate name under the same parent', async () => {
    api = await startFakeCaseServer({
      memberProjectIds: ['1'],
      folders: [fakeFolder({ name: 'Combat' })],
    });

    const { code, sink } = await cli([
      'case',
      'folder',
      'create',
      '--project',
      '1',
      '--name',
      'Combat',
      '--json',
    ]);

    expect(code).toBe(EXIT_FAILURE);
    const error = sink.lastJson<ErrorEnvelope>().error;
    expect(error.code).toBe('case_folder_conflict');
    expect(error.message).toBe('같은 위치에 같은 이름의 folder 가 있습니다.');
  });
});

describe('case folder update', () => {
  it('keeps the parent when only --name is given', async () => {
    api = await startFakeCaseServer({
      memberProjectIds: ['1'],
      folders: [
        fakeFolder({ id: '100', name: 'Combat' }),
        fakeFolder({ id: '101', name: 'Boss', parentId: '100' }),
      ],
    });

    const { code, sink } = await cli([
      'case',
      'folder',
      'update',
      '101',
      '--project',
      '1',
      '--name',
      'Bosses',
      '--json',
    ]);

    expect(code).toBe(EXIT_OK);
    expect(sink.lastJson<TestCaseFolderPayload>()).toMatchObject({
      name: 'Bosses',
      parentId: '100',
    });
    expect(api.requests.at(-1)).toMatchObject({
      method: 'PUT',
      body: { name: 'Bosses', parentId: '100' },
    });
  });

  it('keeps the name and moves to the top level with --root', async () => {
    api = await startFakeCaseServer({
      memberProjectIds: ['1'],
      folders: [
        fakeFolder({ id: '100', name: 'Combat' }),
        fakeFolder({ id: '101', name: 'Boss', parentId: '100' }),
      ],
    });

    const { sink } = await cli([
      'case',
      'folder',
      'update',
      '101',
      '--project',
      '1',
      '--root',
      '--json',
    ]);

    expect(sink.lastJson<TestCaseFolderPayload>()).toMatchObject({ name: 'Boss', parentId: null });
  });

  it('reports case_invalid_request when moving a folder under its own child', async () => {
    api = await startFakeCaseServer({
      memberProjectIds: ['1'],
      folders: [
        fakeFolder({ id: '100', name: 'Combat' }),
        fakeFolder({ id: '101', name: 'Boss', parentId: '100' }),
      ],
    });

    const { code, sink } = await cli([
      'case',
      'folder',
      'update',
      '100',
      '--project',
      '1',
      '--parent',
      '101',
      '--json',
    ]);

    expect(code).toBe(EXIT_FAILURE);
    expect(sink.lastJson<ErrorEnvelope>().error.code).toBe('case_invalid_request');
  });

  it('reports case_folder_not_found without sending a PUT for a folder that is not listed', async () => {
    api = await startFakeCaseServer({ memberProjectIds: ['1'] });

    const { code, sink } = await cli([
      'case',
      'folder',
      'update',
      '999',
      '--project',
      '1',
      '--name',
      'x',
      '--json',
    ]);

    expect(code).toBe(EXIT_FAILURE);
    expect(sink.lastJson<ErrorEnvelope>().error.code).toBe('case_folder_not_found');
    expect(api.requests.some((request) => request.method === 'PUT')).toBe(false);
  });

  it('is a usage error with nothing to change, and with both --parent and --root', async () => {
    api = await startFakeCaseServer({ memberProjectIds: ['1'] });

    const nothing = await cli(['case', 'folder', 'update', '100', '--project', '1']);
    const both = await cli([
      'case',
      'folder',
      'update',
      '100',
      '--project',
      '1',
      '--parent',
      '2',
      '--root',
    ]);

    expect(nothing.code).toBe(EXIT_USAGE);
    expect(both.code).toBe(EXIT_USAGE);
    expect(api.requests).toEqual([]);
  });
});

describe('case folder delete', () => {
  it('deletes the folder and its subfolders, leaving their cases in no folder', async () => {
    api = await startFakeCaseServer({
      memberProjectIds: ['1'],
      folders: [
        fakeFolder({ id: '100', name: 'Combat' }),
        fakeFolder({ id: '101', name: 'Boss', parentId: '100' }),
      ],
      items: [fakeTestCase({ id: '5', folderId: '101' })],
    });

    const { code, sink } = await cli([
      'case',
      'folder',
      'delete',
      '100',
      '--project',
      '1',
      '--json',
    ]);

    expect(code).toBe(EXIT_OK);
    const payload = sink.lastJson<CaseFolderDeletePayload>();
    expect(Object.keys(payload).sort()).toEqual(FOLDER_DELETE_KEYS);
    expect(payload).toEqual({ id: '100', projectId: '1', deleted: true });
    expect(api.folders()).toEqual([]);
    expect(api.items()[0]?.folderId).toBeNull();
  });
});

describe('case move', () => {
  it('moves cases into a folder and reports how many the server moved', async () => {
    api = await startFakeCaseServer({
      memberProjectIds: ['1'],
      folders: [fakeFolder({ id: '100' })],
      items: [fakeTestCase({ id: '5' }), fakeTestCase({ id: '6' })],
    });

    const { code, sink } = await cli([
      'case',
      'move',
      '5',
      '6',
      '999',
      '--project',
      '1',
      '--folder',
      '100',
      '--json',
    ]);

    expect(code).toBe(EXIT_OK);
    const payload = sink.lastJson<CaseMovePayload>();
    expect(Object.keys(payload).sort()).toEqual(MOVE_KEYS);
    expect(payload).toEqual({ projectId: '1', folderId: '100', requested: 3, moved: 2 });
    expect(api.requests.at(-1)?.body).toEqual({ caseIds: ['5', '6', '999'], folderId: '100' });
  });

  it('says which ids were skipped in human output', async () => {
    api = await startFakeCaseServer({
      memberProjectIds: ['1'],
      folders: [fakeFolder({ id: '100' })],
      items: [fakeTestCase({ id: '5' })],
    });

    const { sink } = await cli(['case', 'move', '5', '999', '--project', '1', '--folder', '100']);

    expect(sink.stdout).toEqual([
      'Moved 1/2 test case(s) to folder 100 in project 1.',
      '  1 id(s) were skipped: they do not exist in this project.',
    ]);
  });

  it('sends folderId null with --root', async () => {
    api = await startFakeCaseServer({
      memberProjectIds: ['1'],
      items: [fakeTestCase({ id: '5', folderId: '100' })],
    });

    const { sink } = await cli(['case', 'move', '5', '--project', '1', '--root', '--json']);

    expect(sink.lastJson<CaseMovePayload>().folderId).toBeNull();
    expect(api.requests.at(-1)?.body).toEqual({ caseIds: ['5'], folderId: null });
    expect(api.items()[0]?.folderId).toBeNull();
  });

  it('is a usage error without --folder or --root, so nothing moves to the top level by accident', async () => {
    api = await startFakeCaseServer({ memberProjectIds: ['1'] });

    const { code } = await cli(['case', 'move', '5', '--project', '1']);

    expect(code).toBe(EXIT_USAGE);
    expect(api.requests).toEqual([]);
  });

  it('reports case_folder_not_found for a folder in another project', async () => {
    api = await startFakeCaseServer({
      memberProjectIds: ['1', '2'],
      folders: [fakeFolder({ id: '200', projectId: '2' })],
      items: [fakeTestCase({ id: '5' })],
    });

    const { code, sink } = await cli([
      'case',
      'move',
      '5',
      '--project',
      '1',
      '--folder',
      '200',
      '--json',
    ]);

    expect(code).toBe(EXIT_FAILURE);
    expect(sink.lastJson<ErrorEnvelope>().error.code).toBe('case_folder_not_found');
  });
});

describe('case list --folder and case create --folder', () => {
  it('lists only the cases directly in the folder, or in no folder with --root', async () => {
    api = await startFakeCaseServer({
      memberProjectIds: ['1'],
      folders: [
        fakeFolder({ id: '100' }),
        fakeFolder({ id: '101', parentId: '100', name: 'Boss' }),
      ],
      items: [
        fakeTestCase({ id: '5', folderId: '100' }),
        fakeTestCase({ id: '6', folderId: '101' }),
        fakeTestCase({ id: '7' }),
      ],
    });

    const inFolder = await cli(['case', 'list', '--project', '1', '--folder', '100', '--json']);
    const atRoot = await cli(['case', 'list', '--project', '1', '--root', '--json']);

    expect(inFolder.sink.lastJson<CaseListPayload>().items.map((item) => item.id)).toEqual(['5']);
    expect(atRoot.sink.lastJson<CaseListPayload>().items.map((item) => item.id)).toEqual(['7']);
  });

  it('fills folderId from --folder, but a folderId in the body wins', async () => {
    api = await startFakeCaseServer({
      memberProjectIds: ['1'],
      folders: [fakeFolder({ id: '100' }), fakeFolder({ id: '101', name: 'Shop' })],
    });
    const body = JSON.stringify([
      { scene: 'Title', step: 'Tap', expectedValue: 'Opens' },
      { scene: 'Shop', step: 'Buy', expectedValue: 'Paid', folderId: '101' },
    ]);
    const sink = createMemorySink();

    const code = await runCaseCreate(
      { json: true, project: '1', folder: '100' },
      sink,
      envFor(api),
      undefined,
      Readable.from([body]),
    );

    expect(code).toBe(EXIT_OK);
    expect(api.items().map((item) => item.folderId)).toEqual(['100', '101']);
    const created = sink.lastJson<{ results: { created: TestCasePayload }[] }>().results;
    expect(created.map((result) => result.created.folderId)).toEqual(['100', '101']);
  });
});
