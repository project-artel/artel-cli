import http from 'node:http';

/**
 * `ProjectController.list` 와 `GameInstanceController.list` 를 흉내 내는 loopback 서버.
 * `case-helpers.ts` 와 같은 방식으로 진짜 HTTP 를 쓴다 — 목록 응답의 봉투 모양까지 검증하려면
 * 요청과 응답이 실제로 직렬화되어야 한다.
 *
 * 서버 쪽 규칙을 그대로 옮긴다: 참여하지 않은 프로젝트의 game instance 목록은 존재 여부조차
 * 알리지 않고 404 다.
 */

export interface FakeProject {
  id: string;
  name: string;
  genre: string;
  description: string | null;
  documentCount: number;
  latestDocument: null;
  myRole: string;
  updatedAt: string;
}

export interface FakeInstance {
  id: string;
  projectId: string;
  name: string;
  platform: string;
  connected: boolean;
  lastConnectedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FakeDiscoveryServerOptions {
  projects?: FakeProject[];
  instances?: FakeInstance[];
  /** 여기 없는 projectId 로 game instance 를 물으면 404 다. */
  memberProjectIds?: string[];
}

export interface FakeDiscoveryServer {
  baseUrl: string;
  requests: { method: string; path: string }[];
  close(): Promise<void>;
}

const FIXED_AT = '2026-09-03T05:00:00Z';

export function fakeProject(overrides: Partial<FakeProject> = {}): FakeProject {
  return {
    id: '1',
    name: 'WordVenture',
    genre: 'RPG',
    description: null,
    documentCount: 0,
    latestDocument: null,
    myRole: 'OWNER',
    updatedAt: FIXED_AT,
    ...overrides,
  };
}

export function fakeInstance(overrides: Partial<FakeInstance> = {}): FakeInstance {
  return {
    id: '10',
    projectId: '1',
    name: 'WordVenture on desktop',
    platform: 'WindowsPlayer',
    connected: true,
    lastConnectedAt: FIXED_AT,
    createdAt: FIXED_AT,
    updatedAt: FIXED_AT,
    ...overrides,
  };
}

export async function startFakeDiscoveryServer(
  options: FakeDiscoveryServerOptions = {},
): Promise<FakeDiscoveryServer> {
  const projects = options.projects ?? [];
  const instances = options.instances ?? [];
  const memberProjectIds = options.memberProjectIds ?? ['1'];
  const requests: { method: string; path: string }[] = [];

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    requests.push({ method: request.method ?? 'GET', path: request.url ?? '/' });

    const json = (status: number, body: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };

    if (request.method === 'GET' && url.pathname === '/api/projects') {
      // 서버의 페이지 나누기를 그대로 흉내 낸다. `page`·`size`·`total` 이 실제 값이어야
      // "받은 것이 전부인지" 를 CLI 가 판단하는 자리가 검증된다.
      const page = Number(url.searchParams.get('page') ?? '0');
      const size = Number(url.searchParams.get('size') ?? '20');
      const start = page * size;
      json(200, {
        items: projects.slice(start, start + size),
        page,
        size,
        total: projects.length,
      });
      return;
    }

    const instanceMatch = /^\/api\/projects\/([^/]+)\/game-instances$/.exec(url.pathname);
    if (request.method === 'GET' && instanceMatch) {
      const projectId = decodeURIComponent(instanceMatch[1] ?? '');
      if (!memberProjectIds.includes(projectId)) {
        json(404, { code: 'not_found', message: '프로젝트를 찾을 수 없습니다.' });
        return;
      }
      json(200, { items: instances.filter((item) => item.projectId === projectId) });
      return;
    }

    json(404, { code: 'not_found', message: 'no such endpoint' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the fake discovery server did not bind a port');
  }

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    requests,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}
