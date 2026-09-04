import { afterEach, describe, expect, it } from 'vitest';

import { runDocScan } from '../src/commands/doc/scan.js';
import { CliError } from '../src/errors.js';
import { EXIT_FAILURE, EXIT_OK } from '../src/exit.js';
import type { ContentMapScanPayload } from '../src/output/contract.js';
import type { ContentMapScanEvent } from '../src/doc/scan-flow.js';
import { ingestFrame, scanFrame, startFakeDocServer, type FakeDocServer } from './doc-helpers.js';
import { createMemorySink, waitUntil, type MemorySink } from './helpers.js';

/** 재연결을 실제 시간으로 기다리지 않게 아주 짧게 잡는다. */
const FAST = { reconnectDelaysMs: [5, 5, 5] } as const;

let api: FakeDocServer;

afterEach(async () => {
  await api.close();
});

function envFor(server: FakeDocServer): NodeJS.ProcessEnv {
  return { ARTEL_TOKEN: 'artel_test_token', ARTEL_API_BASE_URL: server.baseUrl };
}

function scanEvents(sink: MemorySink): ContentMapScanEvent[] {
  return sink.stderr
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as ContentMapScanEvent);
}

function baseOptions(): { json: true; project: string; build: string; timeoutSeconds: number } {
  return { json: true, project: '12', build: '34', timeoutSeconds: 30 };
}

describe('doc scan', () => {
  it('sends the order, reports REQUESTED, and never opens the stream without --watch', async () => {
    api = await startFakeDocServer();
    const sink = createMemorySink();

    const code = await runDocScan({ ...baseOptions(), watch: false }, sink, envFor(api));

    expect(code).toBe(EXIT_OK);
    expect(api.scanCalls).toHaveLength(1);
    expect(api.scanCalls[0]?.projectId).toBe('12');
    expect(api.scanCalls[0]?.gameBuildId).toBe('34');
    expect(api.scanCalls[0]?.authorization).toBe('Bearer artel_test_token');
    // 202 는 "명령이 나갔다" 이지 "끝났다" 가 아니다. 기본 동작은 거기서 끝난다.
    expect(api.streamOpens).toHaveLength(0);

    const payload = sink.lastJson<ContentMapScanPayload>();
    expect(payload.state).toBe('REQUESTED');
    expect(payload.watched).toBe(false);
    expect(payload.gameInstanceId).toBe('9');
    expect(payload.finishedAt).toBeNull();
    expect(payload.ingestedDocuments).toBeNull();
  });

  it('says the game is not attached when the server answers 409, not that the build is missing', async () => {
    api = await startFakeDocServer({
      scanStatus: 409,
      scanFailureBody:
        '{"code":"game_instance_not_connected","message":"이 빌드를 실행 중인 게임이 붙어 있지 않습니다."}',
    });
    const sink = createMemorySink();

    const error = await runDocScan({ ...baseOptions(), watch: false }, sink, envFor(api)).then(
      () => null,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe('content_map_game_not_connected');
    expect((error as CliError).message).toContain('no running game is attached');
    expect((error as CliError).message).toContain('The build id and the project id are both fine');
  });

  it('says the id did not resolve when the server answers 404, not that the game is off', async () => {
    api = await startFakeDocServer({
      scanStatus: 404,
      scanFailureBody: '{"code":"not_found","message":"게임 빌드를 찾을 수 없습니다."}',
    });
    const sink = createMemorySink();

    const error = await runDocScan({ ...baseOptions(), watch: false }, sink, envFor(api)).then(
      () => null,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe('content_map_build_not_found');
    expect((error as CliError).message).toContain('There is no game build 34 under project 12');
    expect((error as CliError).message).toContain('not the same as "the game is not running"');
  });

  it('keeps 409 and 404 as different error codes', async () => {
    api = await startFakeDocServer({ scanStatus: 409, scanFailureBody: '{}' });
    const conflict = await runDocScan(
      { ...baseOptions(), watch: false },
      createMemorySink(),
      envFor(api),
    ).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    await api.close();

    api = await startFakeDocServer({ scanStatus: 404, scanFailureBody: '{}' });
    const missing = await runDocScan(
      { ...baseOptions(), watch: false },
      createMemorySink(),
      envFor(api),
    ).then(
      () => null,
      (thrown: unknown) => thrown,
    );

    expect((conflict as CliError).code).not.toBe((missing as CliError).code);
  });

  it('follows the stream to SUCCEEDED with --watch and carries a Bearer token onto the SSE request', async () => {
    api = await startFakeDocServer();
    const sink = createMemorySink();

    const scanning = runDocScan({ ...baseOptions(), watch: true, ...FAST }, sink, envFor(api));

    await waitUntil(() => api.streamOpens.length > 0);
    api.emitContentMap(scanFrame('REQUESTED'));
    api.emitContentMap(ingestFrame(2, 1));
    api.emitContentMap(
      scanFrame('SUCCEEDED', { finishedAt: '2026-09-04T00:22:00Z', ingestedDocuments: 2 }),
    );

    expect(await scanning).toBe(EXIT_OK);
    // SSE 도 Authorization header 로 인증된다. cookie 를 만들 필요가 없다.
    expect(api.streamOpens[0]?.authorization).toBe('Bearer artel_test_token');
    expect(api.streamOpens[0]?.accept).toBe('text/event-stream');

    const payload = sink.lastJson<ContentMapScanPayload>();
    expect(payload.state).toBe('SUCCEEDED');
    expect(payload.watched).toBe(true);
    expect(payload.ingestedDocuments).toBe(2);

    const events = scanEvents(sink);
    expect(events.some((event) => event.kind === 'ingest')).toBe(true);
    expect(events.filter((event) => event.kind === 'scan-state')).toHaveLength(2);
  });

  it('exits 1 when the scan itself failed, and still prints the payload', async () => {
    api = await startFakeDocServer();
    const sink = createMemorySink();

    const scanning = runDocScan({ ...baseOptions(), watch: true, ...FAST }, sink, envFor(api));

    await waitUntil(() => api.streamOpens.length > 0);
    api.emitContentMap(
      scanFrame('FAILED', {
        finishedAt: '2026-09-04T00:21:00Z',
        error: 'the game answered that the walk broke',
      }),
    );

    expect(await scanning).toBe(EXIT_FAILURE);
    const payload = sink.lastJson<ContentMapScanPayload>();
    expect(payload.state).toBe('FAILED');
    expect(payload.error).toBe('the game answered that the walk broke');
  });

  it('finishes on a snapshot that is already terminal', async () => {
    api = await startFakeDocServer();
    const sink = createMemorySink();

    const scanning = runDocScan({ ...baseOptions(), watch: true, ...FAST }, sink, envFor(api));

    await waitUntil(() => api.streamOpens.length > 0);
    // 짧은 스캔은 202 를 받고 붙는 사이에 이미 끝나 있을 수 있고, 그때 `scan` frame 은 다시
    // 오지 않는다. snapshot 만 보고도 끝나야 한다.
    api.emitContentMap({
      type: 'snapshot',
      scan: scanFrame('SUCCEEDED', { ingestedDocuments: 1 })['scan'],
      ingest: { receivedDocuments: 1, ingestedDocuments: 1, failedDocuments: 0 },
    });

    expect(await scanning).toBe(EXIT_OK);
    expect(sink.lastJson<ContentMapScanPayload>().state).toBe('SUCCEEDED');
  });

  it('reconnects when the stream drops before the scan ends', async () => {
    api = await startFakeDocServer();
    const sink = createMemorySink();

    const scanning = runDocScan({ ...baseOptions(), watch: true, ...FAST }, sink, envFor(api));

    await waitUntil(() => api.streamOpens.length > 0);
    api.dropStreams();
    await waitUntil(() => api.streamOpens.length > 1);
    api.emitContentMap(scanFrame('SUCCEEDED', { ingestedDocuments: 0 }));

    expect(await scanning).toBe(EXIT_OK);
    expect(scanEvents(sink).some((event) => event.kind === 'reconnect')).toBe(true);
  });

  it('gives up with content_map_watch_disconnected when it can never reattach', async () => {
    api = await startFakeDocServer();
    const sink = createMemorySink();

    const scanning = runDocScan(
      { ...baseOptions(), watch: true, reconnectDelaysMs: [1, 1] },
      sink,
      envFor(api),
    ).then(
      () => null,
      (thrown: unknown) => thrown,
    );

    await waitUntil(() => api.streamOpens.length > 0);
    const closer = setInterval(() => {
      api.dropStreams();
    }, 2);
    const error = await scanning;
    clearInterval(closer);

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe('content_map_watch_disconnected');
    expect((error as CliError).message).toContain('The scan was requested either way');
  });
});
