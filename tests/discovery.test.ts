import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runGameList } from '../src/commands/game/list.js';
import { runProjectList } from '../src/commands/project/list.js';
import { writeCredential } from '../src/credentials/store.js';
import { CREDENTIAL_FILE_VERSION } from '../src/credentials/types.js';
import type { CliError } from '../src/errors.js';
import type { GameInstanceListPayload, ProjectListPayload } from '../src/output/contract.js';
import { createMemorySink, createTempConfig, type TempConfig } from './helpers.js';
import {
  fakeInstance,
  fakeProject,
  startFakeDiscoveryServer,
  type FakeDiscoveryServer,
} from './discovery-helpers.js';

let temp: TempConfig;
let server: FakeDiscoveryServer;

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

describe('artel project list', () => {
  it('names every project the credential can see', async () => {
    server = await startFakeDiscoveryServer({
      projects: [
        fakeProject({ id: '1', name: 'WordVenture' }),
        fakeProject({ id: '2', name: 'Second Game', myRole: 'MEMBER' }),
      ],
    });
    await signIn(server.baseUrl);
    const sink = createMemorySink();

    await runProjectList({ json: true, page: 0, limit: 100 }, sink, envOf());

    const payload = sink.lastJson<ProjectListPayload>();
    expect(payload.items.map((item) => item.id)).toEqual(['1', '2']);
    expect(payload.total).toBe(2);
  });

  /**
   * 받은 것이 전부가 아닌 경우를 조용히 자르면, 없는 프로젝트를 없다고 읽는다. `total` 을
   * 봉투에 실어 두는 이유가 이것이고, 사람 출력도 남은 개수를 말해야 한다.
   */
  it('says how many did not fit and which page holds them', async () => {
    server = await startFakeDiscoveryServer({
      projects: [fakeProject({ id: '1' }), fakeProject({ id: '2' }), fakeProject({ id: '3' })],
    });
    await signIn(server.baseUrl);
    const sink = createMemorySink();

    await runProjectList({ json: false, page: 0, limit: 2 }, sink, envOf());

    const printed = sink.stdout.join('\n');
    expect(printed).toContain('2 of 3 project(s)');
    expect(printed).toContain('--page 1');
  });

  it('reads the page it was asked for', async () => {
    server = await startFakeDiscoveryServer({
      projects: [fakeProject({ id: '1' }), fakeProject({ id: '2' }), fakeProject({ id: '3' })],
    });
    await signIn(server.baseUrl);
    const sink = createMemorySink();

    await runProjectList({ json: true, page: 1, limit: 2 }, sink, envOf());

    expect(sink.lastJson<ProjectListPayload>().items.map((item) => item.id)).toEqual(['3']);
  });

  /** 읽기는 결과가 비어도 성공이다. `set -e` 스크립트가 빈 목록에서 죽으면 안 된다. */
  it('reports an empty list as a success', async () => {
    server = await startFakeDiscoveryServer({ projects: [] });
    await signIn(server.baseUrl);
    const sink = createMemorySink();

    await runProjectList({ json: false, page: 0, limit: 100 }, sink, envOf());

    expect(sink.stdout.join('\n')).toContain('No projects');
  });

  /** 이 명령이 실제로 쓰이는 방식이다 — 로그인 한 번 뒤에는 주소를 다시 적지 않는다. */
  it('needs no address flag once the machine is signed in', async () => {
    server = await startFakeDiscoveryServer({ projects: [fakeProject()] });
    await signIn(server.baseUrl);
    const sink = createMemorySink();

    await runProjectList({ json: true, page: 0, limit: 100 }, sink, envOf());

    expect(sink.lastJson<ProjectListPayload>().items).toHaveLength(1);
  });
});

describe('artel game list', () => {
  it('names the instances of one project with their connection state', async () => {
    server = await startFakeDiscoveryServer({
      instances: [
        fakeInstance({ id: '10', projectId: '1', connected: true }),
        fakeInstance({ id: '11', projectId: '1', connected: false, lastConnectedAt: null }),
        fakeInstance({ id: '20', projectId: '2' }),
      ],
      memberProjectIds: ['1'],
    });
    await signIn(server.baseUrl);
    const sink = createMemorySink();

    await runGameList({ json: true, project: '1' }, sink, envOf());

    const payload = sink.lastJson<GameInstanceListPayload>();
    expect(payload.items.map((item) => item.id)).toEqual(['10', '11']);
    expect(payload.items.map((item) => item.connected)).toEqual([true, false]);
  });

  it('tells a person which instance is actually reachable', async () => {
    server = await startFakeDiscoveryServer({
      instances: [fakeInstance({ id: '10', connected: false, lastConnectedAt: null })],
    });
    await signIn(server.baseUrl);
    const sink = createMemorySink();

    await runGameList({ json: false, project: '1' }, sink, envOf());

    expect(sink.stdout.join('\n')).toContain('offline (last never)');
  });

  it('points at "game start" when the project has no instance yet', async () => {
    server = await startFakeDiscoveryServer({ instances: [] });
    await signIn(server.baseUrl);
    const sink = createMemorySink();

    await runGameList({ json: false, project: '1' }, sink, envOf());

    expect(sink.stdout.join('\n')).toContain('artel game start');
  });

  it('reports a project it cannot see as a readable failure', async () => {
    server = await startFakeDiscoveryServer({ memberProjectIds: ['1'] });
    await signIn(server.baseUrl);

    const failure = (await runGameList(
      { json: true, project: '999' },
      createMemorySink(),
      envOf(),
    ).catch((error: unknown) => error)) as CliError;

    expect(failure.message).toContain('프로젝트를 찾을 수 없습니다');
  });
});
