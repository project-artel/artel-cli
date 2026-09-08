import http from 'node:http';

export interface ListedTry {
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
  qaRunId: string | null;
}

export function listedTry(overrides: Partial<ListedTry> = {}): ListedTry {
  return {
    id: '100',
    testScenarioId: '1',
    gameInstanceId: '10',
    startedBy: '1',
    status: 'COMPLETED',
    startedAt: '2026-09-08T05:00:00Z',
    completedAt: '2026-09-08T05:04:00Z',
    model: 'openai/gpt-5.6-luna',
    promptVersion: 'v16',
    agentArch: null,
    agentFingerprint: null,
    runConfig: { reasoning: { effort: 'medium' } },
    qaRunId: '9',
    ...overrides,
  };
}

export interface FakeListServer {
  baseUrl: string;
  queries: string[];
  close(): Promise<void>;
}

/**
 * `QaTryController.list` 만 흉내 낸다. 서버가 `size` 를 1..100 밖이면 400 으로 막는 것까지
 * 옮긴다 — CLI 가 미리 거절한다는 주장은 그 400 이 실재할 때만 의미가 있다.
 */
export async function startFakeListServer(tries: ListedTry[]): Promise<FakeListServer> {
  const queries: string[] = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    queries.push(url.search);
    response.setHeader('content-type', 'application/json');

    if (url.pathname !== '/api/qa-tries') {
      response.writeHead(404);
      response.end('{"code":"not_found","message":"no such endpoint"}');
      return;
    }

    const size = Number(url.searchParams.get('size') ?? '20');
    if (!Number.isInteger(size) || size < 1 || size > 100) {
      response.writeHead(400);
      response.end('{"code":"bad_request","message":"size must be between 1 and 100"}');
      return;
    }

    response.writeHead(200);
    response.end(JSON.stringify(tries.slice(0, size)));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the fake list server did not bind a port');
  }
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    queries,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

