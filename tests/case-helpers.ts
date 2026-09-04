import http from 'node:http';

/**
 * `TestCaseController` 를 흉내 내는 loopback 서버. `qa-helpers.ts` 와 같은 방식으로 진짜
 * HTTP 를 쓴다 — CRUD 왕복이라 mocking 보다 실제 소켓을 쓰는 편이 요청/응답 직렬화까지
 * 검증한다.
 *
 * 서버 쪽 규칙을 그대로 옮긴다: 멤버가 아닌 프로젝트는 목록에서는 빈 배열(존재를 숨김),
 * 생성/조회/수정/삭제에서는 404 다. 필수 필드(`scene`/`step`/`expectedValue`) 가 비면 400.
 */

export interface FakeTestCase {
  id: string;
  projectId: string;
  scene: string;
  step: string;
  precondition: string | null;
  expectedValue: string;
  status: string | null;
  verificationStatus: string;
  lastVerifiedBuildId: string | null;
  createdAt: string;
  evidenceGaps: string[];
}

export interface FakeCaseServerOptions {
  /** 멤버로 접근 가능한 프로젝트. 나머지 projectId 는 전부 비멤버로 취급한다. */
  memberProjectIds: string[];
  items?: FakeTestCase[];
}

export interface FakeCaseServer {
  baseUrl: string;
  requests: { method: string; path: string; body: unknown }[];
  items: () => FakeTestCase[];
  close(): Promise<void>;
}

const VERIFICATION_STATUSES = ['DRAFT', 'VERIFIED', 'BROKEN'];
const FIXED_CREATED_AT = '2026-09-03T05:00:00Z';

export function fakeTestCase(overrides: Partial<FakeTestCase> = {}): FakeTestCase {
  return {
    id: '1',
    projectId: '1',
    scene: 'Title Screen',
    step: 'Tap "New Game"',
    precondition: null,
    expectedValue: 'The naming screen appears.',
    status: null,
    verificationStatus: 'DRAFT',
    lastVerifiedBuildId: null,
    createdAt: FIXED_CREATED_AT,
    evidenceGaps: [],
    ...overrides,
  };
}

export async function startFakeCaseServer(options: FakeCaseServerOptions): Promise<FakeCaseServer> {
  const memberProjectIds = new Set(options.memberProjectIds);
  const items = new Map<string, FakeTestCase>((options.items ?? []).map((item) => [item.id, item]));
  const requests: { method: string; path: string; body: unknown }[] = [];
  let nextId = Math.max(0, ...[...items.keys()].map((id) => Number.parseInt(id, 10) || 0)) + 1;

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const method = request.method ?? 'GET';

    readBody(request, (rawBody) => {
      const body = rawBody.length === 0 ? null : (JSON.parse(rawBody) as unknown);
      requests.push({ method, path: url.pathname, body });

      const listMatch = /^\/api\/projects\/([^/]+)\/test-cases$/.exec(url.pathname);
      if (method === 'GET' && listMatch !== null) {
        const projectId = decodeURIComponent(listMatch[1] ?? '');
        const mine = memberProjectIds.has(projectId)
          ? [...items.values()].filter((item) => item.projectId === projectId)
          : [];
        send(response, 200, JSON.stringify({ items: mine.map(toListShape) }));
        return;
      }

      if (method === 'POST' && listMatch !== null) {
        const projectId = decodeURIComponent(listMatch[1] ?? '');
        if (!memberProjectIds.has(projectId)) {
          send(response, 404, notFound(`Project ${projectId}`));
          return;
        }
        const fields = (body as Record<string, unknown> | null) ?? {};
        const scene = asOptionalString(fields['scene']);
        const step = asOptionalString(fields['step']);
        const precondition = asOptionalString(fields['precondition']);
        const expectedValue = asOptionalString(fields['expectedValue']);
        const missing = [
          ['scene', scene],
          ['step', step],
          ['expectedValue', expectedValue],
        ].find(([, value]) => value === undefined || value.trim() === '');
        if (missing !== undefined) {
          send(response, 400, invalidRequest(`${String(missing[0])} is required`));
          return;
        }
        const created: FakeTestCase = {
          id: String(nextId),
          projectId,
          scene: scene ?? '',
          step: step ?? '',
          precondition:
            precondition !== undefined && precondition.trim() !== '' ? precondition : null,
          expectedValue: expectedValue ?? '',
          status: null,
          verificationStatus: 'DRAFT',
          lastVerifiedBuildId: null,
          createdAt: FIXED_CREATED_AT,
          evidenceGaps: [],
        };
        nextId += 1;
        items.set(created.id, created);
        send(response, 201, JSON.stringify(toListShape(created)));
        return;
      }

      const itemMatch = /^\/api\/projects\/([^/]+)\/test-cases\/([^/]+)$/.exec(url.pathname);
      if (itemMatch !== null) {
        const projectId = decodeURIComponent(itemMatch[1] ?? '');
        const caseId = decodeURIComponent(itemMatch[2] ?? '');
        const existing = items.get(caseId);
        const accessible = existing !== undefined && memberProjectIds.has(projectId);

        if (method === 'GET') {
          if (!accessible || existing === undefined) {
            send(response, 404, notFound(`Test case ${caseId}`));
            return;
          }
          send(response, 200, JSON.stringify(toDetailShape(existing)));
          return;
        }

        if (method === 'PUT') {
          if (!accessible || existing === undefined) {
            send(response, 404, notFound(`Test case ${caseId}`));
            return;
          }
          const fields = (body as Record<string, unknown> | null) ?? {};
          const scene = asOptionalString(fields['scene']);
          const step = asOptionalString(fields['step']);
          const expectedValue = asOptionalString(fields['expectedValue']);
          const verificationStatus = asOptionalString(fields['verificationStatus']);
          if (
            verificationStatus !== undefined &&
            !VERIFICATION_STATUSES.includes(verificationStatus)
          ) {
            send(
              response,
              400,
              invalidRequest(
                `verificationStatus must be one of ${VERIFICATION_STATUSES.join(', ')}`,
              ),
            );
            return;
          }
          const precondition = asOptionalString(fields['precondition']);
          const updated: FakeTestCase = {
            ...existing,
            scene: scene ?? existing.scene,
            step: step ?? existing.step,
            precondition:
              'precondition' in fields
                ? precondition !== undefined && precondition.trim() !== ''
                  ? precondition
                  : null
                : existing.precondition,
            expectedValue: expectedValue ?? existing.expectedValue,
            verificationStatus: verificationStatus ?? existing.verificationStatus,
          };
          items.set(caseId, updated);
          send(response, 200, JSON.stringify(toListShape(updated)));
          return;
        }

        if (method === 'DELETE') {
          if (!accessible || existing === undefined) {
            send(response, 404, notFound(`Test case ${caseId}`));
            return;
          }
          items.delete(caseId);
          response.writeHead(204);
          response.end();
          return;
        }
      }

      send(response, 404, notFound('route'));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the fake case server did not bind to a TCP port');
  }

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    requests,
    items: () => [...items.values()],
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

function toListShape(item: FakeTestCase): Omit<FakeTestCase, 'evidenceGaps'> {
  const { evidenceGaps, ...rest } = item;
  void evidenceGaps;
  return rest;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function toDetailShape(item: FakeTestCase): FakeTestCase {
  return item;
}

function notFound(what: string): string {
  return JSON.stringify({ code: 'not_found', message: `${what} was not found.` });
}

function invalidRequest(message: string): string {
  return JSON.stringify({ code: 'invalid_request', message });
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
