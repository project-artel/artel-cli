import http from 'node:http';

/**
 * `TestRunController` 흉내. `qa-helpers.ts` 와 같은 방식으로 진짜 loopback HTTP 서버를 쓴다.
 *
 * 서버의 실제 라우팅과 한 가지 다르게 두는 자리가 있다: 실서버는 `{runId}` 로 갈리는
 * endpoint(get/update/delete/scenarios) 에서 URL 의 `{projectId}` 를 실제로 검사하지 않고
 * `run.projectId` 로만 접근을 가른다(`TestRunService.accessible`). 이 fake 도 같은 규율을
 * 따른다 — `{projectId}` 는 라우팅에만 쓰고, 인가는 저장된 run 의 `projectId` 로 가른다.
 */

export interface FakeTestRun {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  createdAt: string;
}

export interface FakeDeletionPreview {
  scenarioCount: number;
  removableScenarioCount: number;
  keptForQaHistoryCount: number;
}

export interface FakeTestRunServerOptions {
  runs?: FakeTestRun[];
  /** runId → 순서대로의 scenario id 목록. */
  scenarios?: Record<string, string[]>;
  /** runId → deletion preview. 주지 않은 run 은 전부 0 이다. */
  deletionPreviews?: Record<string, FakeDeletionPreview>;
  /** 주면 이 runId 의 `DELETE` 가 이 status/body 로 실패한다(`run_has_qa_history` 검증용). */
  deleteFailsWith?: Record<string, { status: number; body: string }>;
  /** 주면 `POST /test-runs` 가 이 status/body 로 실패한다. */
  createFailsWith?: { status: number; body: string };
  /** 주면 `PUT /{runId}/scenarios` 가 이 status/body 로 실패한다. */
  setScenariosFailsWith?: { status: number; body: string };
}

export interface FakeTestRunServer {
  baseUrl: string;
  runs: FakeTestRun[];
  scenarios: Record<string, string[]>;
  createBodies: unknown[];
  updateBodies: { runId: string; body: unknown }[];
  setScenariosBodies: { runId: string; body: unknown }[];
  deleteCalls: { runId: string; dropScenarios: string | null }[];
  close(): Promise<void>;
}

let nextRunId = 100;

export function fakeTestRun(overrides: Partial<FakeTestRun> = {}): FakeTestRun {
  nextRunId += 1;
  return {
    id: String(nextRunId),
    projectId: '1',
    name: 'benchmark v1',
    description: null,
    createdAt: '2026-09-03T05:00:00Z',
    ...overrides,
  };
}

export async function startFakeTestRunServer(
  options: FakeTestRunServerOptions = {},
): Promise<FakeTestRunServer> {
  const runs = [...(options.runs ?? [])];
  const scenarios: Record<string, string[]> = { ...(options.scenarios ?? {}) };
  const deletionPreviews = options.deletionPreviews ?? {};
  const createBodies: unknown[] = [];
  const updateBodies: { runId: string; body: unknown }[] = [];
  const setScenariosBodies: { runId: string; body: unknown }[] = [];
  const deleteCalls: { runId: string; dropScenarios: string | null }[] = [];

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const method = request.method ?? 'GET';
    const path = url.pathname;

    const listOrCreateMatch = /^\/api\/projects\/([^/]+)\/test-runs$/.exec(path);
    if (listOrCreateMatch !== null) {
      const projectId = decodeURIComponent(listOrCreateMatch[1] ?? '');
      if (method === 'GET') {
        const items = runs.filter((run) => run.projectId === projectId);
        send(response, 200, JSON.stringify({ items }));
        return;
      }
      if (method === 'POST') {
        readBody(request, (body) => {
          createBodies.push(JSON.parse(body));
          if (options.createFailsWith !== undefined) {
            send(response, options.createFailsWith.status, options.createFailsWith.body);
            return;
          }
          const parsed = JSON.parse(body) as { name?: string; description?: string | null };
          const run = fakeTestRun({
            projectId,
            name: parsed.name ?? '',
            description: parsed.description ?? null,
          });
          runs.push(run);
          scenarios[run.id] = [];
          send(response, 201, JSON.stringify(run));
        });
        return;
      }
    }

    const previewMatch = /^\/api\/projects\/([^/]+)\/test-runs\/([^/]+)\/deletion-preview$/.exec(
      path,
    );
    if (method === 'GET' && previewMatch !== null) {
      const runId = decodeURIComponent(previewMatch[2] ?? '');
      const run = runs.find((item) => item.id === runId);
      if (run === undefined) {
        send(response, 404, '');
        return;
      }
      const preview = deletionPreviews[runId] ?? {
        scenarioCount: 0,
        removableScenarioCount: 0,
        keptForQaHistoryCount: 0,
      };
      send(response, 200, JSON.stringify({ testRunId: runId, ...preview }));
      return;
    }

    const scenariosMatch = /^\/api\/projects\/([^/]+)\/test-runs\/([^/]+)\/scenarios$/.exec(path);
    if (scenariosMatch !== null) {
      const runId = decodeURIComponent(scenariosMatch[2] ?? '');
      const run = runs.find((item) => item.id === runId);
      if (run === undefined) {
        send(response, 404, '');
        return;
      }
      if (method === 'GET') {
        send(response, 200, JSON.stringify(toRunScenariosResponse(runId, scenarios)));
        return;
      }
      if (method === 'PUT') {
        readBody(request, (body) => {
          setScenariosBodies.push({ runId, body: JSON.parse(body) });
          if (options.setScenariosFailsWith !== undefined) {
            send(
              response,
              options.setScenariosFailsWith.status,
              options.setScenariosFailsWith.body,
            );
            return;
          }
          const parsed = JSON.parse(body) as { scenarioIds: string[] };
          scenarios[runId] = [...parsed.scenarioIds];
          send(response, 200, JSON.stringify(toRunScenariosResponse(runId, scenarios)));
        });
        return;
      }
    }

    const byIdMatch = /^\/api\/projects\/([^/]+)\/test-runs\/([^/]+)$/.exec(path);
    if (byIdMatch !== null) {
      const runId = decodeURIComponent(byIdMatch[2] ?? '');
      const index = runs.findIndex((item) => item.id === runId);

      if (method === 'GET') {
        if (index < 0) {
          send(response, 404, '');
          return;
        }
        send(response, 200, JSON.stringify(runs[index]));
        return;
      }

      if (method === 'PUT') {
        if (index < 0) {
          send(response, 404, '');
          return;
        }
        readBody(request, (body) => {
          updateBodies.push({ runId, body: JSON.parse(body) });
          const parsed = JSON.parse(body) as { name?: string | null; description?: string | null };
          const existing = runs[index];
          if (existing === undefined) {
            send(response, 404, '');
            return;
          }
          const updated: FakeTestRun = {
            ...existing,
            name:
              parsed.name === undefined || parsed.name === null || parsed.name === ''
                ? existing.name
                : parsed.name,
            description:
              parsed.description === undefined
                ? existing.description
                : parsed.description === ''
                  ? null
                  : parsed.description,
          };
          runs[index] = updated;
          send(response, 200, JSON.stringify(updated));
        });
        return;
      }

      if (method === 'DELETE') {
        const dropScenarios = url.searchParams.get('dropScenarios');
        deleteCalls.push({ runId, dropScenarios });
        const failure = options.deleteFailsWith?.[runId];
        if (failure !== undefined) {
          send(response, failure.status, failure.body);
          return;
        }
        const removed = index >= 0 ? runs.splice(index, 1)[0] : undefined;
        const dropped = dropScenarios === 'true';
        const removedScenarioCount = dropped ? (scenarios[runId]?.length ?? 0) : 0;
        if (removed !== undefined) {
          delete scenarios[runId];
        }
        send(
          response,
          200,
          JSON.stringify({
            deletedScenarioCount: removedScenarioCount,
            keptForQaHistoryCount: 0,
          }),
        );
        return;
      }
    }

    send(response, 404, '{"code":"not_found","message":"no such route"}');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the fake test-run server did not bind to a TCP port');
  }

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    runs,
    scenarios,
    createBodies,
    updateBodies,
    setScenariosBodies,
    deleteCalls,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    },
  };
}

function toRunScenariosResponse(
  runId: string,
  scenarios: Record<string, string[]>,
): { testRunId: string; items: { position: number; testScenarioId: string }[] } {
  const ids = scenarios[runId] ?? [];
  return {
    testRunId: runId,
    items: ids.map((testScenarioId, position) => ({ position, testScenarioId })),
  };
}

function send(response: http.ServerResponse, status: number, body: string): void {
  if (body.length === 0) {
    response.writeHead(status);
    response.end();
    return;
  }
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
