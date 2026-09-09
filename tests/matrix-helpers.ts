import http from 'node:http';

import { SDK_TOKEN_MINT_PATH } from '../src/http/client.js';
import { terminalLog, type FakeQaLog } from './qa-helpers.js';

/**
 * `qa matrix` 가 부르는 endpoint 를 한 서버에서 답한다.
 *
 * `startFakeGameServer`(게임 등록)와 `startFakeQaServer`(QA 런) 를 따로 세울 수 없어서 하나로
 * 합쳤다 — matrix 는 조합 하나마다 게임을 띄우고 그 게임에 런을 걸므로 두 벌의 endpoint 를
 * 같은 주소에서 본다.
 *
 * SSE 는 쓰지 않는다. 여기서 만드는 런은 생성 시점에 이미 종단 상태라, `followQaRun` 이 첫
 * 조회에서 끝난 것을 보고 곧장 돌아온다. 이 파일이 확인하려는 것은 stream 재연결이 아니라
 * 슬롯이 조합을 어떤 순서로 집는지다.
 */

export interface CreateQaRunBody {
  testRunId: string;
  gameInstanceId: string;
  model?: string;
  promptVersion?: string;
  arch?: unknown;
  contentMapMode?: string;
  knowledgeMode?: string;
  label?: string;
  force?: boolean;
}

export interface FakeMatrixServerOptions {
  sdkToken: string;
  /** 이 조합의 `POST /api/qa-runs` 를 실패시킬지. `null` 이면 성공한다. */
  failCreate?: (body: CreateQaRunBody) => { status: number; body: string } | null;
  /** 런의 판정. 기본은 통과다. */
  verdictOf?: (body: CreateQaRunBody) => 'PASSED' | 'FAILED';
}

export interface FakeMatrixServer {
  baseUrl: string;
  createBodies: CreateQaRunBody[];
  /**
   * 무슨 일이 어떤 순서로 일어났는지. `launch:<build>`, `kill:<build>`,
   * `create:<build>` 세 가지다. 슬롯 하나에서 이 셋이 `launch → create → kill` 로 되풀이되면
   * 그 슬롯은 런을 겹쳐 걸지 않았고 런 사이에 게임을 다시 띄운 것이다.
   */
  timeline: string[];
  /** 테스트의 spawner 가 게임을 띄울 때 부른다. 그 빌드의 game instance 를 연결 상태로 만든다. */
  registerLaunch(build: string): void;
  /** 테스트의 spawner 가 게임이 죽었을 때 부른다. */
  noteKill(build: string): void;
  instanceIdOf(build: string): string | undefined;
  close(): Promise<void>;
}

interface FakeInstance {
  id: string;
  projectId: string;
  name: string;
  platform: string;
  connected: boolean;
  lastConnectedAt: string;
  createdAt: string;
  updatedAt: string;
}

interface StoredRun {
  id: string;
  testRunId: string;
  gameInstanceId: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  tries: {
    id: string;
    testScenarioId: string;
    gameInstanceId: string;
    status: string;
    startedAt: string;
    completedAt: string | null;
    model: string | null;
    promptVersion: string | null;
    agentArch: string | null;
    agentFingerprint: string | null;
    runConfig: unknown;
  }[];
}

export async function startFakeMatrixServer(
  options: FakeMatrixServerOptions,
): Promise<FakeMatrixServer> {
  const createBodies: CreateQaRunBody[] = [];
  const timeline: string[] = [];
  const instances = new Map<string, FakeInstance>();
  const buildOfInstance = new Map<string, string>();
  const runs = new Map<string, StoredRun>();
  const logs = new Map<string, FakeQaLog[]>();
  // 등록 시각은 단조 증가해야 한다. `findNewlyRegisteredInstance` 가 계속 연결돼 있던 행을
  // "다시 붙었다" 로 읽는 근거가 `lastConnectedAt` 이 더 최근이라는 것뿐이다.
  let clock = 0;
  let nextRunId = 0;

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const method = request.method ?? 'GET';

    if (method === 'POST' && url.pathname === SDK_TOKEN_MINT_PATH) {
      send(response, 200, {
        token: options.sdkToken,
        expiresAt: null,
        refreshToken: 'refresh_token_value',
        refreshExpiresAt: null,
        userId: 'user-1',
        displayName: 'Test User',
      });
      return;
    }

    const projectMatch = /^\/api\/projects\/([^/]+)\/game-instances$/.exec(url.pathname);
    if (method === 'GET' && projectMatch !== null) {
      send(response, 200, { items: [...instances.values()] });
      return;
    }

    if (method === 'POST' && url.pathname === '/api/qa-runs') {
      readBody(request, (raw) => {
        const body = JSON.parse(raw) as CreateQaRunBody;
        createBodies.push(body);
        timeline.push(`create:${buildOfInstance.get(body.gameInstanceId) ?? body.gameInstanceId}`);

        const failure = options.failCreate?.(body) ?? null;
        if (failure !== null) {
          response.writeHead(failure.status, { 'content-type': 'application/json' });
          response.end(failure.body);
          return;
        }

        nextRunId += 1;
        const runId = `run-${String(nextRunId)}`;
        const tryId = `try-${String(nextRunId)}`;
        const verdict = options.verdictOf?.(body) ?? 'PASSED';
        const run: StoredRun = {
          id: runId,
          testRunId: body.testRunId,
          gameInstanceId: body.gameInstanceId,
          // 생성 시점에 이미 끝난 런이다. matrix 가 확인하려는 것은 stream 이 아니라 순서다.
          status: 'COMPLETED',
          startedAt: '2026-09-04T00:00:00Z',
          completedAt: '2026-09-04T00:01:00Z',
          tries: [
            {
              id: tryId,
              testScenarioId: '1',
              gameInstanceId: body.gameInstanceId,
              status: 'COMPLETED',
              startedAt: '2026-09-04T00:00:00Z',
              completedAt: '2026-09-04T00:01:00Z',
              model: 'openai/gpt-5.6-luna',
              promptVersion: 'v15',
              agentArch: 'v2-tool-loop',
              agentFingerprint: 'e8e1d4764809',
              runConfig: { reasoning: { effort: 'high' } },
            },
          ],
        };
        runs.set(runId, run);
        logs.set(tryId, [
          terminalLog(
            tryId,
            verdict,
            {
              total: 3,
              passed: verdict === 'PASSED' ? 3 : 1,
              failed: verdict === 'PASSED' ? 0 : 2,
            },
            {
              total: 1,
              passed: verdict === 'PASSED' ? 1 : 0,
              failed: verdict === 'PASSED' ? 0 : 1,
            },
          ),
        ]);
        send(response, 201, run);
      });
      return;
    }

    const cancelMatch = /^\/api\/qa-runs\/([^/]+)\/cancel$/.exec(url.pathname);
    if (method === 'POST' && cancelMatch !== null) {
      response.writeHead(204);
      response.end();
      return;
    }

    const runMatch = /^\/api\/qa-runs\/([^/]+)$/.exec(url.pathname);
    if (method === 'GET' && runMatch !== null) {
      const run = runs.get(runMatch[1] ?? '');
      if (run === undefined) {
        send(response, 404, { code: 'not_found', message: 'no such run' });
        return;
      }
      send(response, 200, run);
      return;
    }

    const logsMatch = /^\/api\/qa-tries\/([^/]+)\/logs$/.exec(url.pathname);
    if (method === 'GET' && logsMatch !== null) {
      send(response, 200, {
        items: logs.get(logsMatch[1] ?? '') ?? [],
        nextBeforeId: null,
        hasMore: false,
      });
      return;
    }

    const issuesMatch = /^\/api\/qa-tries\/([^/]+)\/issues$/.exec(url.pathname);
    if (method === 'GET' && issuesMatch !== null) {
      send(response, 200, { items: [], nextBeforeId: null, hasMore: false });
      return;
    }

    send(response, 404, { code: 'not_found', message: 'no such route' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the fake matrix server did not bind to a TCP port');
  }

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    createBodies,
    timeline,
    registerLaunch(build) {
      timeline.push(`launch:${build}`);
      clock += 1;
      const at = `2026-09-04T00:00:${String(clock).padStart(2, '0')}Z`;
      const existing = instances.get(build);
      if (existing === undefined) {
        const id = `instance-${String(instances.size + 1)}`;
        instances.set(build, {
          id,
          projectId: '42',
          name: build,
          platform: 'UNITY',
          connected: true,
          lastConnectedAt: at,
          createdAt: at,
          updatedAt: at,
        });
        buildOfInstance.set(id, build);
        return;
      }
      existing.connected = true;
      existing.lastConnectedAt = at;
      existing.updatedAt = at;
    },
    noteKill(build) {
      timeline.push(`kill:${build}`);
      const existing = instances.get(build);
      if (existing !== undefined) {
        existing.connected = false;
      }
    },
    instanceIdOf(build) {
      return instances.get(build)?.id;
    },
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

function send(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function readBody(request: http.IncomingMessage, done: (body: string) => void): void {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    done(Buffer.concat(chunks).toString('utf8'));
  });
}
