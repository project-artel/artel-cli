import http from 'node:http';

/**
 * QA endpoint 를 흉내 내는 loopback 서버.
 *
 * `startFakeGameServer` 와 같은 방식으로 진짜 HTTP 를 쓴다. SSE 는 mocking 으로는 검증되지
 * 않는 것이 너무 많다 — 재연결이 `afterId` 를 이어받는지, 끊긴 소켓을 어떻게 읽는지, 종단
 * frame 에서 응답이 닫히는지는 전부 실제 소켓의 성질이다.
 */

export interface FakeQaTry {
  id: string;
  testScenarioId: string;
  gameInstanceId: string;
  startedBy: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  model: string | null;
  promptVersion: string | null;
  agentArch: string | null;
  agentFingerprint: string | null;
  runConfig: unknown;
  qaRunId: string;
}

export interface FakeQaRun {
  id: string;
  testRunId: string;
  gameInstanceId: string;
  startedBy: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  tries: FakeQaTry[];
}

export interface FakeQaLog {
  id: string;
  qaTryId: string;
  messageId: string | null;
  correlationId: string | null;
  direction: string;
  type: string;
  message: string | null;
  payload: unknown;
  createdAt: string;
}

export interface FakeQaIssue {
  id: string;
  qaTryId: string;
  severity: string;
  title: string;
  status: string;
  reportedAt: string;
}

export interface FakeQaServerOptions {
  run: FakeQaRun;
  logs?: FakeQaLog[];
  issues?: FakeQaIssue[];
  stats?: unknown;
  /** 주면 `POST /api/qa-runs` 가 이 status 와 body 로 실패한다. */
  createFailsWith?: { status: number; body: string };
  /** 주면 `POST /api/qa-runs/{id}/cancel` 이 이 status 와 body 로 실패한다. */
  cancelFailsWith?: { status: number; body: string };
}

export interface FakeQaServer {
  baseUrl: string;
  run: FakeQaRun;
  createBodies: unknown[];
  /** SSE 를 연 순서대로 `(tryId, afterId)`. 재연결이 이어받았는지를 여기서 본다. */
  streamOpens: { tryId: string; afterId: string }[];
  /** 로그 한 줄을 붙이고, 열려 있는 stream 에 흘린다. 종단 frame 이면 상태도 함께 옮긴다. */
  append(log: FakeQaLog): void;
  /** 열려 있는 SSE 소켓을 전부 끊는다. 클라이언트에게는 연결이 죽은 것으로 보인다. */
  dropStreams(): void;
  setRunStatus(status: string, completedAt: string | null): void;
  close(): Promise<void>;
}

interface OpenStream {
  tryId: string;
  response: http.ServerResponse;
}

const TERMINAL_STATUSES = ['COMPLETED', 'FAILED', 'CANCELLED'];

export async function startFakeQaServer(options: FakeQaServerOptions): Promise<FakeQaServer> {
  const run = options.run;
  const logs = [...(options.logs ?? [])];
  const issues = [...(options.issues ?? [])];
  const createBodies: unknown[] = [];
  const streamOpens: { tryId: string; afterId: string }[] = [];
  const open: OpenStream[] = [];

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const method = request.method ?? 'GET';

    if (method === 'POST' && url.pathname === '/api/qa-runs') {
      readBody(request, (body) => {
        createBodies.push(JSON.parse(body));
        if (options.createFailsWith !== undefined) {
          send(response, options.createFailsWith.status, options.createFailsWith.body);
          return;
        }
        send(response, 201, JSON.stringify(run));
      });
      return;
    }

    const cancelMatch = /^\/api\/qa-runs\/([^/]+)\/cancel$/.exec(url.pathname);
    if (method === 'POST' && cancelMatch !== null) {
      if (options.cancelFailsWith !== undefined) {
        send(response, options.cancelFailsWith.status, options.cancelFailsWith.body);
        return;
      }
      run.status = 'CANCELLED';
      run.completedAt = '2026-09-03T06:00:00Z';
      response.writeHead(204);
      response.end();
      return;
    }

    const runMatch = /^\/api\/qa-runs\/([^/]+)$/.exec(url.pathname);
    if (method === 'GET' && runMatch !== null) {
      send(response, 200, JSON.stringify(run));
      return;
    }

    const logsMatch = /^\/api\/qa-tries\/([^/]+)\/logs$/.exec(url.pathname);
    if (method === 'GET' && logsMatch !== null) {
      const tryId = logsMatch[1] ?? '';
      const size = Number.parseInt(url.searchParams.get('size') ?? '50', 10);
      const mine = logs.filter((log) => log.qaTryId === tryId);
      send(
        response,
        200,
        JSON.stringify({ items: mine.slice(-size), nextBeforeId: null, hasMore: false }),
      );
      return;
    }

    const issuesMatch = /^\/api\/qa-tries\/([^/]+)\/issues$/.exec(url.pathname);
    if (method === 'GET' && issuesMatch !== null) {
      const tryId = issuesMatch[1] ?? '';
      send(
        response,
        200,
        JSON.stringify({
          items: issues.filter((issue) => issue.qaTryId === tryId),
          nextBeforeId: null,
          hasMore: false,
        }),
      );
      return;
    }

    const eventsMatch = /^\/api\/qa-tries\/([^/]+)\/events$/.exec(url.pathname);
    if (method === 'GET' && eventsMatch !== null) {
      const tryId = eventsMatch[1] ?? '';
      const afterId = url.searchParams.get('afterId') ?? '0';
      streamOpens.push({ tryId, afterId });
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const stream: OpenStream = { tryId, response };
      open.push(stream);
      let ended = false;
      for (const log of logs) {
        if (log.qaTryId !== tryId || Number(log.id) <= Number(afterId)) {
          continue;
        }
        writeEvent(response, log);
        if (isTerminal(log)) {
          ended = true;
          break;
        }
      }
      if (ended) {
        closeStream(open, stream);
      }
      return;
    }

    if (method === 'GET' && url.pathname === '/api/qa-stats') {
      send(response, 200, JSON.stringify(options.stats ?? { cells: [] }));
      return;
    }

    send(response, 404, '{"code":"not_found","message":"no such route"}');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the fake QA server did not bind to a TCP port');
  }

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    run,
    createBodies,
    streamOpens,
    append(log) {
      logs.push(log);
      if (isTerminal(log)) {
        const qaTry = run.tries.find((item) => item.id === log.qaTryId);
        if (qaTry !== undefined) {
          qaTry.status = statusOf(log);
          qaTry.completedAt = '2026-09-03T06:00:00Z';
        }
        if (run.tries.every((item) => TERMINAL_STATUSES.includes(item.status))) {
          run.status = run.tries.some((item) => item.status === 'FAILED') ? 'FAILED' : 'COMPLETED';
          run.completedAt = '2026-09-03T06:00:00Z';
        }
      }
      for (const stream of [...open]) {
        if (stream.tryId !== log.qaTryId) {
          continue;
        }
        writeEvent(stream.response, log);
        if (isTerminal(log)) {
          closeStream(open, stream);
        }
      }
    },
    dropStreams() {
      for (const stream of [...open]) {
        stream.response.destroy();
        removeStream(open, stream);
      }
    },
    setRunStatus(status, completedAt) {
      run.status = status;
      run.completedAt = completedAt;
    },
    async close() {
      for (const stream of [...open]) {
        stream.response.destroy();
      }
      open.length = 0;
      server.closeAllConnections();
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    },
  };
}

function send(response: http.ServerResponse, status: number, body: string): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(body);
}

function readBody(request: http.IncomingMessage, done: (body: string) => void): void {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    done(Buffer.concat(chunks).toString('utf8'));
  });
}

function writeEvent(response: http.ServerResponse, log: FakeQaLog): void {
  response.write(`id: ${log.id}\nevent: log\ndata: ${JSON.stringify(log)}\n\n`);
}

function closeStream(open: OpenStream[], stream: OpenStream): void {
  stream.response.end();
  removeStream(open, stream);
}

function removeStream(open: OpenStream[], stream: OpenStream): void {
  const index = open.indexOf(stream);
  if (index >= 0) {
    open.splice(index, 1);
  }
}

function isTerminal(log: FakeQaLog): boolean {
  if (log.type !== 'STATUS') {
    return false;
  }
  const payload = log.payload as Record<string, unknown> | null;
  return (
    payload !== null &&
    typeof payload['status'] === 'string' &&
    TERMINAL_STATUSES.includes(payload['status']) &&
    payload['completedAt'] !== null &&
    payload['completedAt'] !== undefined
  );
}

function statusOf(log: FakeQaLog): string {
  const payload = log.payload as Record<string, unknown>;
  return typeof payload['status'] === 'string' ? payload['status'] : 'COMPLETED';
}

let nextLogId = 100;

/** 스텝 판정 frame. `result` 가 없고 `step` 이 있다 — 서버의 `findStepVerdicts` 와 같은 모양. */
export function stepLog(tryId: string, step: number, passed: boolean, message: string): FakeQaLog {
  nextLogId += 1;
  return {
    id: String(nextLogId),
    qaTryId: tryId,
    messageId: null,
    correlationId: null,
    direction: 'AGENT_TO_ORCHE',
    type: 'STATUS',
    message,
    payload: {
      step,
      result: null,
      status: passed ? 'COMPLETED' : 'FAILED',
      case_id: null,
      message,
    },
    createdAt: '2026-09-03T05:53:00Z',
  };
}

/** 종단 frame. `completedAt` 이 있어야 런의 끝으로 읽힌다. */
export function terminalLog(
  tryId: string,
  result: 'PASSED' | 'FAILED',
  steps: { total: number; passed: number; failed: number },
  cases: { total: number; passed: number; failed: number },
): FakeQaLog {
  nextLogId += 1;
  return {
    id: String(nextLogId),
    qaTryId: tryId,
    messageId: null,
    correlationId: null,
    direction: 'AGENT_TO_ORCHE',
    type: 'STATUS',
    message: 'done',
    payload: {
      step: null,
      result,
      status: 'COMPLETED',
      case_id: null,
      message: 'done',
      summary: {
        steps: {
          ...steps,
          items: Array.from({ length: steps.total }, (_, index) => ({
            step: index + 1,
            passed: index < steps.passed,
            case_id: null,
            message: `step ${String(index + 1)}`,
            is_verification: false,
          })),
        },
        cases: { ...cases, items: [] },
      },
      completedAt: '2026-09-03T06:00:00Z',
    },
    createdAt: '2026-09-03T06:00:00Z',
  };
}

/** 요약 없이 끝난 런: 소켓이 죽거나 취소된 경로가 남기는 frame. 판정은 미상이다. */
export function abortedLog(tryId: string, status: 'FAILED' | 'CANCELLED'): FakeQaLog {
  nextLogId += 1;
  return {
    id: String(nextLogId),
    qaTryId: tryId,
    messageId: null,
    correlationId: null,
    direction: 'ORCHE_INTERNAL',
    type: 'STATUS',
    message: null,
    payload: { status, completedAt: '2026-09-03T06:00:00Z' },
    createdAt: '2026-09-03T06:00:00Z',
  };
}

export function fakeQaTry(id: string, overrides: Partial<FakeQaTry> = {}): FakeQaTry {
  return {
    id,
    testScenarioId: '1',
    gameInstanceId: '1',
    startedBy: '1',
    status: 'PENDING',
    startedAt: '2026-09-03T05:52:57Z',
    completedAt: null,
    model: 'openai/gpt-5.6-luna',
    promptVersion: 'v15',
    agentArch: 'v2-tool-loop',
    agentFingerprint: 'e8e1d4764809',
    runConfig: { reasoning: { effort: 'high' } },
    qaRunId: '4',
    ...overrides,
  };
}

export function fakeQaRun(overrides: Partial<FakeQaRun> = {}): FakeQaRun {
  return {
    id: '4',
    testRunId: '1',
    gameInstanceId: '1',
    startedBy: '1',
    status: 'STARTING',
    startedAt: '2026-09-03T05:52:57Z',
    completedAt: null,
    tries: [fakeQaTry('4')],
    ...overrides,
  };
}
