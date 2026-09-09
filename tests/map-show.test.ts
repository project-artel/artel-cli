import { afterEach, describe, expect, it } from 'vitest';

import { runMapShow } from '../src/commands/map/show.js';
import type { ContentMapViewPayload } from '../src/output/contract.js';
import { EXIT_OK, runCli } from '../src/run.js';
import { startFakeDocServer, type FakeDocServer } from './doc-helpers.js';
import { createMemorySink } from './helpers.js';

const FILLED_MAP = {
  contentMap: { id: '7', ingestedAt: '2026-09-08T05:00:00Z' },
  scenes: [{ id: 's1' }, { id: 's2' }, { id: 's3' }],
  edges: [{ id: 'e1' }, { id: 'e2' }],
  screenTransitions: [{ id: 't1' }],
  gaps: [{ reason: 'NO_EVIDENCE', count: 4 }],
  verification: { verified: 5, total: 8 },
  pendingDocuments: [],
  lastScan: {
    gameInstanceId: '10',
    gameInstanceName: 'WordVenture slot A',
    state: 'SUCCEEDED',
    requestedAt: '2026-09-08T04:59:00Z',
    finishedAt: '2026-09-08T05:00:00Z',
    ingestedDocuments: 2,
    error: null,
  },
};

let api: FakeDocServer;

afterEach(async () => {
  await api.close();
});

function envOf(): NodeJS.ProcessEnv {
  return { ARTEL_API_BASE_URL: api.baseUrl, ARTEL_TOKEN: 'artel_env_token' };
}

function baseOptions() {
  return { json: true, project: '1', build: '2', watch: false, timeoutSeconds: 5 };
}

describe('artel map show', () => {
  it('counts what the map holds', async () => {
    api = await startFakeDocServer({ contentMap: FILLED_MAP });
    const sink = createMemorySink();

    await runMapShow(baseOptions(), sink, envOf());

    expect(sink.lastJson<ContentMapViewPayload>()).toMatchObject({
      contentMapId: '7',
      scenes: 3,
      edges: 2,
      screenTransitions: 1,
      gaps: 1,
      verifiedFeatures: 5,
      totalFeatures: 8,
      lastScanState: 'SUCCEEDED',
    });
  });

  /**
   * 두 "없음" 은 다음에 할 일이 다르다. 하나는 문서를 올리는 것이고, 다른 하나는 앉기를
   * 기다리거나 왜 못 앉았는지 보는 것이다. 같은 문장으로 덮으면 안 된다.
   */
  it('says a build with no evidence document differently from one that has not ingested yet', async () => {
    api = await startFakeDocServer({ contentMap: { ...FILLED_MAP, contentMap: null } });
    const empty = createMemorySink();
    await runMapShow({ ...baseOptions(), json: false }, empty, envOf());
    await api.close();

    api = await startFakeDocServer({
      contentMap: { ...FILLED_MAP, contentMap: { id: '7', ingestedAt: null } },
    });
    const pending = createMemorySink();
    await runMapShow({ ...baseOptions(), json: false }, pending, envOf());

    expect(empty.stdout.join('\n')).toContain('no evidence document has been registered');
    expect(pending.stdout.join('\n')).toContain('nothing has been ingested into it yet');
  });

  /** 지도가 없어도 조회는 성공이다. 서버가 그것을 200 으로 두는 이유와 같다. */
  it('reports a build with no map as a success', async () => {
    api = await startFakeDocServer({});

    const code = await runCli(
      ['map', 'show', '--project', '1', '--build', '2'],
      createMemorySink(),
      envOf(),
    );

    expect(code).toBe(EXIT_OK);
  });

  it('carries the reason the last scan failed', async () => {
    api = await startFakeDocServer({
      contentMap: {
        ...FILLED_MAP,
        lastScan: { ...FILLED_MAP.lastScan, state: 'FAILED', error: 'the game went away' },
      },
    });
    const sink = createMemorySink();

    await runMapShow({ ...baseOptions(), json: false }, sink, envOf());

    expect(sink.stdout.join('\n')).toContain('FAILED');
    expect(sink.stdout.join('\n')).toContain('the game went away');
  });

  /**
   * 서버가 뜬 뒤로 시킨 적이 없다는 뜻이지 지도가 스캔 없이 생겼다는 뜻이 아니다. 그 둘을
   * 구별해 적지 않으면 지도가 어디서 왔는지 오해한다.
   */
  it('says no scan since the server started rather than pretending there was none', async () => {
    api = await startFakeDocServer({ contentMap: { ...FILLED_MAP, lastScan: null } });
    const sink = createMemorySink();

    await runMapShow({ ...baseOptions(), json: false }, sink, envOf());

    expect(sink.stdout.join('\n')).toContain('none since the server started');
  });

  describe('--json key set', () => {
    const KEYS = [
      'contentMapId',
      'edges',
      'gameBuildId',
      'gaps',
      'ingestedAt',
      'lastScanError',
      'lastScanFinishedAt',
      'lastScanState',
      'pendingDocuments',
      'projectId',
      'scenes',
      'screenTransitions',
      'totalFeatures',
      'verifiedFeatures',
    ];

    it('emits exactly its contracted keys', async () => {
      api = await startFakeDocServer({ contentMap: FILLED_MAP });
      const sink = createMemorySink();

      await runMapShow(baseOptions(), sink, envOf());

      expect(Object.keys(sink.lastJson<ContentMapViewPayload>()).sort()).toEqual(KEYS);
    });
  });
});
