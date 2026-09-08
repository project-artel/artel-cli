import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runQaList } from '../src/commands/qa/list.js';
import { writeCredential } from '../src/credentials/store.js';
import { CREDENTIAL_FILE_VERSION } from '../src/credentials/types.js';
import type { QaListPayload } from '../src/output/contract.js';
import { EXIT_OK, EXIT_USAGE, runCli } from '../src/run.js';
import { createMemorySink, createTempConfig, type TempConfig } from './helpers.js';
import {
  listedTry,
  startFakeListServer,
  type FakeListServer,
} from './qa-list-helpers.js';

let temp: TempConfig;
let server: FakeListServer;

beforeEach(async () => {
  temp = await createTempConfig();
});

afterEach(async () => {
  await server.close();
  await temp.cleanup();
});

async function signIn(apiBaseUrl: string): Promise<void> {
  await writeCredential(
    {
      version: CREDENTIAL_FILE_VERSION,
      token: 'artel_stored',
      tokenId: '01JXSTORED',
      tokenName: 'artel-cli@laptop',
      createdAt: '2026-09-03T04:11:07Z',
      expiresAt: null,
      apiBaseUrl,
    },
    { ARTEL_CONFIG_DIR: temp.configDir },
  );
}

function envOf(): NodeJS.ProcessEnv {
  return { ARTEL_CONFIG_DIR: temp.configDir };
}

describe('artel qa list', () => {
  it('carries the run id every other qa command takes', async () => {
    server = await startFakeListServer([listedTry({ id: '100', qaRunId: '9' })]);
    await signIn(server.baseUrl);
    const sink = createMemorySink();

    await runQaList({ json: true, project: '1', limit: 20 }, sink, envOf());

    const payload = sink.lastJson<QaListPayload>();
    expect(payload.items[0]?.id).toBe('100');
    expect(payload.items[0]?.qaRunId).toBe('9');
  });

  it('reads reasoning effort out of the run config snapshot', async () => {
    server = await startFakeListServer([listedTry()]);
    await signIn(server.baseUrl);
    const sink = createMemorySink();

    await runQaList({ json: true, project: '1', limit: 20 }, sink, envOf());

    expect(sink.lastJson<QaListPayload>().items[0]?.reasoningEffort).toBe('medium');
  });

  it('sends the project and the limit the server asked for', async () => {
    server = await startFakeListServer([listedTry()]);
    await signIn(server.baseUrl);

    await runQaList({ json: true, project: '7', limit: 5 }, createMemorySink(), envOf());

    expect(server.queries[0]).toBe('?projectId=7&size=5');
  });

  /**
   * `--status` 는 서버가 아니라 CLI 에서 걸린다. 두 수를 함께 내지 않으면 읽는 쪽이 "이
   * 프로젝트에 FAILED 가 하나뿐" 이라고 잘못 읽는다.
   */
  it('says how many it filtered and how many it had', async () => {
    server = await startFakeListServer([
      listedTry({ id: '100', status: 'COMPLETED' }),
      listedTry({ id: '101', status: 'FAILED' }),
      listedTry({ id: '102', status: 'COMPLETED' }),
    ]);
    await signIn(server.baseUrl);
    const sink = createMemorySink();

    await runQaList({ json: true, project: '1', limit: 20, status: 'failed' }, sink, envOf());

    const payload = sink.lastJson<QaListPayload>();
    expect(payload.items.map((item) => item.id)).toEqual(['101']);
    expect(payload.fetched).toBe(3);
    expect(payload.statusFilter).toBe('failed');
  });

  it('warns in the human output that the filter only saw what came back', async () => {
    server = await startFakeListServer([listedTry({ status: 'COMPLETED' })]);
    await signIn(server.baseUrl);
    const sink = createMemorySink();

    await runQaList({ json: false, project: '1', limit: 20, status: 'FAILED' }, sink, envOf());

    expect(sink.stdout.join('\n')).toContain('the server has no status filter');
  });

  /** 읽기는 판정과 무관하게 성공이다. `qa show` 와 같은 규칙이다. */
  it('exits 0 even when every try it lists failed', async () => {
    server = await startFakeListServer([listedTry({ status: 'FAILED' })]);
    await signIn(server.baseUrl);

    const code = await runCli(['qa', 'list', '--project', '1'], createMemorySink(), envOf());

    expect(code).toBe(EXIT_OK);
  });

  it('refuses a limit the server would reject, without asking it', async () => {
    server = await startFakeListServer([listedTry()]);
    await signIn(server.baseUrl);

    const code = await runCli(
      ['qa', 'list', '--project', '1', '--limit', '101'],
      createMemorySink(),
      envOf(),
    );

    expect(code).toBe(EXIT_USAGE);
    expect(server.queries).toHaveLength(0);
  });

  it('reports an empty project as a success', async () => {
    server = await startFakeListServer([]);
    await signIn(server.baseUrl);
    const sink = createMemorySink();

    await runQaList({ json: false, project: '1', limit: 20 }, sink, envOf());

    expect(sink.stdout.join('\n')).toContain('No QA tries');
  });
});
