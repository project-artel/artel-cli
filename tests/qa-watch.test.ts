import { afterEach, describe, expect, it } from 'vitest';

import { runQaRun } from '../src/commands/qa/run.js';
import { runQaWatch } from '../src/commands/qa/watch.js';
import { CliError } from '../src/errors.js';
import { EXIT_FAILURE, EXIT_OK } from '../src/exit.js';
import type { QaRunPayload } from '../src/output/contract.js';
import type { QaFollowEvent } from '../src/qa/follow.js';
import { createMemorySink, waitUntil, type MemorySink } from './helpers.js';
import {
  abortedLog,
  fakeQaRun,
  fakeQaTry,
  startFakeQaServer,
  stepLog,
  terminalLog,
  type FakeQaServer,
} from './qa-helpers.js';

/** 재연결과 폴링을 실제 시간으로 기다리지 않게 아주 짧게 잡는다. */
const FAST = { pollIntervalMs: 20, reconnectDelaysMs: [5, 5, 5] } as const;

let api: FakeQaServer;

afterEach(async () => {
  await api.close();
});

function envFor(server: FakeQaServer): NodeJS.ProcessEnv {
  return { ARTEL_TOKEN: 'artel_test_token', ARTEL_API_BASE_URL: server.baseUrl };
}

function followEvents(sink: MemorySink): QaFollowEvent[] {
  return sink.stderr
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as QaFollowEvent);
}

describe('qa watch', () => {
  it('streams every step, then exits 0 on a passing verdict', async () => {
    api = await startFakeQaServer({
      run: fakeQaRun({ status: 'RUNNING', tries: [fakeQaTry('4', { status: 'RUNNING' })] }),
    });

    const sink = createMemorySink();
    const watching = runQaWatch(
      '4',
      { json: true, timeoutSeconds: 30, ...FAST },
      sink,
      envFor(api),
    );

    await waitUntil(() => api.streamOpens.length > 0);
    api.append(stepLog('4', 1, true, 'clicked new game'));
    api.append(stepLog('4', 2, true, 'story scene appeared'));
    api.append(
      terminalLog(
        '4',
        'PASSED',
        { total: 2, passed: 2, failed: 0 },
        { total: 1, passed: 1, failed: 0 },
      ),
    );

    expect(await watching).toBe(EXIT_OK);
    const events = followEvents(sink);
    expect(events.filter((event) => event.kind === 'step')).toHaveLength(2);
    expect(events.some((event) => event.kind === 'try-end' && event.verdict === 'PASSED')).toBe(
      true,
    );
    expect(sink.lastJson<QaRunPayload>().verdict).toBe('PASSED');
    // 종단 frame 을 읽은 뒤 그 try 에 다시 붙지 않는다. 다시 붙으면 이어받을 frame 이 없어
    // stream 이 곧장 닫히고, 그것이 끊긴 연결로 읽혀 재연결을 전부 소모한다.
    expect(api.streamOpens).toHaveLength(1);
    expect(events.some((event) => event.kind === 'reconnect')).toBe(false);
  });

  it('exits 1 when the agent says the run failed', async () => {
    api = await startFakeQaServer({
      run: fakeQaRun({ status: 'RUNNING', tries: [fakeQaTry('4', { status: 'RUNNING' })] }),
    });

    const sink = createMemorySink();
    const watching = runQaWatch(
      '4',
      { json: true, timeoutSeconds: 30, ...FAST },
      sink,
      envFor(api),
    );

    await waitUntil(() => api.streamOpens.length > 0);
    api.append(stepLog('4', 1, false, 'the button did nothing'));
    api.append(
      terminalLog(
        '4',
        'FAILED',
        { total: 2, passed: 1, failed: 1 },
        { total: 1, passed: 0, failed: 1 },
      ),
    );

    expect(await watching).toBe(EXIT_FAILURE);
    expect(sink.lastJson<QaRunPayload>().verdict).toBe('FAILED');
  });

  it('exits 1 when the run ends with no verdict at all', async () => {
    api = await startFakeQaServer({
      run: fakeQaRun({ status: 'RUNNING', tries: [fakeQaTry('4', { status: 'RUNNING' })] }),
    });

    const sink = createMemorySink();
    const watching = runQaWatch(
      '4',
      { json: true, timeoutSeconds: 30, ...FAST },
      sink,
      envFor(api),
    );

    await waitUntil(() => api.streamOpens.length > 0);
    api.append(abortedLog('4', 'FAILED'));

    // 판정이 미상인 런은 통과가 아니다. 0 으로 두면 CI 가 그것을 통과로 읽는다.
    expect(await watching).toBe(EXIT_FAILURE);
    expect(sink.lastJson<QaRunPayload>().verdict).toBeNull();
  });

  it('reconnects from the last event it saw when the stream drops', async () => {
    api = await startFakeQaServer({
      run: fakeQaRun({ status: 'RUNNING', tries: [fakeQaTry('4', { status: 'RUNNING' })] }),
    });

    const sink = createMemorySink();
    const watching = runQaWatch(
      '4',
      { json: true, timeoutSeconds: 30, ...FAST },
      sink,
      envFor(api),
    );

    await waitUntil(() => api.streamOpens.length > 0);
    const first = stepLog('4', 1, true, 'clicked new game');
    api.append(first);
    await waitUntil(() => followEvents(sink).some((event) => event.kind === 'step'));

    api.dropStreams();
    await waitUntil(() => api.streamOpens.length > 1);

    api.append(
      terminalLog(
        '4',
        'PASSED',
        { total: 1, passed: 1, failed: 0 },
        { total: 1, passed: 1, failed: 0 },
      ),
    );

    expect(await watching).toBe(EXIT_OK);
    // 다시 붙을 때 마지막으로 본 id 를 이어받는다. 0 부터 다시 받으면 스텝이 두 번 찍힌다.
    expect(api.streamOpens[1]?.afterId).toBe(first.id);
    expect(followEvents(sink).filter((event) => event.kind === 'step')).toHaveLength(1);
    expect(followEvents(sink).some((event) => event.kind === 'reconnect')).toBe(true);
  });

  it('gives up with qa_watch_disconnected when the run is still going and the stream will not come back', async () => {
    api = await startFakeQaServer({
      run: fakeQaRun({ status: 'RUNNING', tries: [fakeQaTry('4', { status: 'RUNNING' })] }),
    });

    const sink = createMemorySink();
    const watching = runQaWatch(
      '4',
      { json: true, timeoutSeconds: 30, ...FAST },
      sink,
      envFor(api),
    );
    const failure = watching.then(
      () => null,
      (error: unknown) => error,
    );

    // 붙을 때마다 끊는다. 첫 연결과 재시도 세 번이 전부이고, 그것을 다 쓰면 런이 아직
    // RUNNING 이므로 실패로 끝나야 한다.
    for (let opened = 1; opened <= FAST.reconnectDelaysMs.length + 1; opened += 1) {
      await waitUntil(() => api.streamOpens.length >= opened);
      api.dropStreams();
    }

    const error = await failure;
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe('qa_watch_disconnected');
  });

  it('takes the verdict from the logs when the stream dies but the run has already finished', async () => {
    api = await startFakeQaServer({
      run: fakeQaRun({ status: 'RUNNING', tries: [fakeQaTry('4', { status: 'RUNNING' })] }),
      logs: [],
    });

    const sink = createMemorySink();
    const watching = runQaWatch(
      '4',
      { json: true, timeoutSeconds: 30, ...FAST },
      sink,
      envFor(api),
    );

    await waitUntil(() => api.streamOpens.length > 0);
    // 종단 frame 은 서버에 남지만 stream 으로는 전달되지 않는다: 연결이 그 전에 죽는다.
    api.dropStreams();
    api.append(
      terminalLog(
        '4',
        'PASSED',
        { total: 1, passed: 1, failed: 0 },
        { total: 1, passed: 1, failed: 0 },
      ),
    );

    expect(await watching).toBe(EXIT_OK);
    expect(sink.lastJson<QaRunPayload>().verdict).toBe('PASSED');
  });

  it('stops instead of waiting forever on a scenario a cancelled run never reached', async () => {
    api = await startFakeQaServer({
      run: fakeQaRun({
        status: 'RUNNING',
        tries: [fakeQaTry('4', { status: 'PENDING' }), fakeQaTry('5', { status: 'PENDING' })],
      }),
    });

    const sink = createMemorySink();
    const watching = runQaWatch(
      '4',
      { json: true, timeoutSeconds: 30, ...FAST },
      sink,
      envFor(api),
    );

    await waitUntil(() => api.streamOpens.length > 0);
    // 아무 frame 도 없이 런만 닫힌다. try 는 PENDING 인 채로 남고 그 stream 은 스스로 끝나지 않는다.
    api.setRunStatus('CANCELLED', '2026-09-03T06:00:00Z');

    expect(await watching).toBe(EXIT_FAILURE);
    const payload = sink.lastJson<QaRunPayload>();
    expect(payload.status).toBe('CANCELLED');
    expect(payload.verdict).toBeNull();
  });
});

describe('qa run', () => {
  it('sends the four comparison axes and starts without waiting when told not to', async () => {
    api = await startFakeQaServer({ run: fakeQaRun() });

    const sink = createMemorySink();
    const code = await runQaRun(
      {
        json: true,
        testRun: '1',
        instance: '1',
        model: 'openai/gpt-5.6-luna',
        promptVersion: 'v15',
        reasoningEffort: 'high',
        arch: '{"vision":true}',
        force: true,
        wait: false,
        timeoutSeconds: 30,
      },
      sink,
      envFor(api),
    );

    expect(code).toBe(EXIT_OK);
    expect(api.createBodies[0]).toEqual({
      testRunId: '1',
      gameInstanceId: '1',
      model: 'openai/gpt-5.6-luna',
      promptVersion: 'v15',
      reasoning: { effort: 'high' },
      arch: { vision: true },
      force: true,
    });
    // 시작한 것은 통과한 것이 아니다. 판정이 없으므로 미상이고, exit code 는 그래도 0 이다.
    expect(sink.lastJson<QaRunPayload>().verdict).toBeNull();
  });

  it('refuses a bad --arch before it starts anything', async () => {
    api = await startFakeQaServer({ run: fakeQaRun() });

    const sink = createMemorySink();
    await expect(
      runQaRun(
        {
          json: true,
          testRun: '1',
          instance: '1',
          arch: '[1,2]',
          force: false,
          wait: false,
          timeoutSeconds: 30,
        },
        sink,
        envFor(api),
      ),
    ).rejects.toMatchObject({ code: 'qa_invalid_arch' });
    expect(api.createBodies).toHaveLength(0);
  });

  it("turns the server's 409 code into a code of its own", async () => {
    api = await startFakeQaServer({
      run: fakeQaRun(),
      createFailsWith: {
        status: 409,
        body: '{"code":"qa_run_active","message":"An active QA run already exists"}',
      },
    });

    const sink = createMemorySink();
    await expect(
      runQaRun(
        { json: true, testRun: '1', instance: '1', force: false, wait: false, timeoutSeconds: 30 },
        sink,
        envFor(api),
      ),
    ).rejects.toMatchObject({ code: 'qa_run_active' });
  });

  it('starts a run and watches it to a passing verdict', async () => {
    api = await startFakeQaServer({
      run: fakeQaRun({ status: 'RUNNING', tries: [fakeQaTry('4', { status: 'RUNNING' })] }),
    });

    const sink = createMemorySink();
    const running = runQaRun(
      {
        json: true,
        testRun: '1',
        instance: '1',
        force: false,
        wait: true,
        timeoutSeconds: 30,
        ...FAST,
      },
      sink,
      envFor(api),
    );

    await waitUntil(() => api.streamOpens.length > 0);
    api.append(
      terminalLog(
        '4',
        'PASSED',
        { total: 1, passed: 1, failed: 0 },
        { total: 1, passed: 1, failed: 0 },
      ),
    );

    expect(await running).toBe(EXIT_OK);
    expect(sink.lastJson<QaRunPayload>().verdict).toBe('PASSED');
  });
});
