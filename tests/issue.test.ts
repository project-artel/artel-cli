import http from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { runIssueList } from '../src/commands/issue/list.js';
import { runIssueStatusChange } from '../src/commands/issue/status.js';
import type { CliError } from '../src/errors.js';
import type { IssueListPayload, IssueStatusChangePayload } from '../src/output/contract.js';
import { EXIT_OK, runCli } from '../src/run.js';
import { createMemorySink } from './helpers.js';

interface FakeIssue {
  id: string;
  qaTryId: string;
  qaRunId: string | null;
  severity: string;
  title: string;
  detail: Record<string, unknown>;
  status: string;
  reportedAt: string;
  createdAt: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

function fakeIssue(overrides: Partial<FakeIssue> = {}): FakeIssue {
  return {
    id: '5',
    qaTryId: '100',
    qaRunId: '9',
    severity: 'MAJOR',
    title: 'The naming screen never appears',
    detail: { step: 2 },
    status: 'OPEN',
    reportedAt: '2026-09-08T05:04:00Z',
    createdAt: '2026-09-08T05:04:00Z',
    resolvedAt: null,
    resolvedBy: null,
    ...overrides,
  };
}

interface FakeIssueServer {
  baseUrl: string;
  requests: { method: string; url: string }[];
  close(): Promise<void>;
}

/**
 * `ProjectIssueController.list` 와 `IssueController` 의 두 쓰기를 흉내 낸다. 쓰기가 본문 없는
 * 204 라는 것까지 옮긴다 — CLI 가 이슈 객체를 지어내지 않는다는 주장은 서버가 정말 아무것도
 * 주지 않을 때만 의미가 있다.
 */
async function startFakeIssueServer(
  issues: FakeIssue[],
  options: { hasMore?: boolean } = {},
): Promise<FakeIssueServer> {
  const requests: { method: string; url: string }[] = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    requests.push({ method: request.method ?? 'GET', url: request.url ?? '/' });

    const listMatch = /^\/api\/projects\/([^/]+)\/issues$/.exec(url.pathname);
    if (request.method === 'GET' && listMatch) {
      const status = url.searchParams.get('status');
      const severity = url.searchParams.get('severity');
      const items = issues.filter(
        (issue) =>
          (status === null || issue.status === status) &&
          (severity === null || issue.severity === severity),
      );
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          items,
          nextBeforeId: options.hasMore === true ? (items.at(-1)?.id ?? null) : null,
          hasMore: options.hasMore === true,
        }),
      );
      return;
    }

    const writeMatch = /^\/api\/issues\/([^/]+)\/(resolve|reopen)$/.exec(url.pathname);
    if (request.method === 'POST' && writeMatch) {
      const issue = issues.find((candidate) => candidate.id === writeMatch[1]);
      if (issue === undefined) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end('{"code":"not_found","message":"no such issue"}');
        return;
      }
      issue.status = writeMatch[2] === 'resolve' ? 'RESOLVED' : 'OPEN';
      // 본문 없는 204 다.
      response.writeHead(204);
      response.end();
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json' });
    response.end('{"code":"not_found","message":"no such endpoint"}');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the fake issue server did not bind a port');
  }
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    requests,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

// 각 테스트가 자기 서버를 띄운다. 응답이 테스트마다 다르기 때문이다.
let api: FakeIssueServer;

afterEach(async () => {
  await api.close();
});

function envOf(): NodeJS.ProcessEnv {
  return { ARTEL_API_BASE_URL: api.baseUrl, ARTEL_TOKEN: 'artel_env_token' };
}

describe('artel issue list', () => {
  it('carries the run each issue came from', async () => {
    api = await startFakeIssueServer([fakeIssue({ id: '5', qaRunId: '9' })]);
    const sink = createMemorySink();

    await runIssueList({ json: true, project: '1', limit: 50 }, sink, envOf());

    const payload = sink.lastJson<IssueListPayload>();
    expect(payload.items[0]?.id).toBe('5');
    expect(payload.items[0]?.qaRunId).toBe('9');
  });

  /** 서버가 받는 filter 다. CLI 가 받은 것만 거르는 `qa list --status` 와 다르다. */
  it('sends status and severity to the server rather than filtering locally', async () => {
    api = await startFakeIssueServer([
      fakeIssue({ id: '5', status: 'OPEN', severity: 'MAJOR' }),
      fakeIssue({ id: '6', status: 'RESOLVED', severity: 'MINOR' }),
    ]);
    const sink = createMemorySink();

    await runIssueList(
      { json: true, project: '1', limit: 50, status: 'OPEN', severity: 'MAJOR' },
      sink,
      envOf(),
    );

    expect(api.requests[0]?.url).toContain('status=OPEN');
    expect(api.requests[0]?.url).toContain('severity=MAJOR');
    expect(sink.lastJson<IssueListPayload>().items.map((issue) => issue.id)).toEqual(['5']);
  });

  /** 커서를 감추면 받은 것이 전부인 줄 알고 없는 이슈를 없다고 읽는다. */
  it('says there is another page and which cursor opens it', async () => {
    api = await startFakeIssueServer([fakeIssue({ id: '5' })], { hasMore: true });
    const sink = createMemorySink();

    await runIssueList({ json: false, project: '1', limit: 1 }, sink, envOf());

    expect(sink.stdout.join('\n')).toContain('--before 5');
  });

  it('passes the cursor it was given back to the server', async () => {
    api = await startFakeIssueServer([fakeIssue()]);

    await runIssueList(
      { json: true, project: '1', limit: 50, before: '9' },
      createMemorySink(),
      envOf(),
    );

    expect(api.requests[0]?.url).toContain('beforeId=9');
  });

  it('reports an empty result as a success', async () => {
    api = await startFakeIssueServer([]);
    const sink = createMemorySink();

    const code = await runCli(['issue', 'list', '--project', '1'], sink, envOf());

    expect(code).toBe(EXIT_OK);
    expect(sink.stdout.join('\n')).toContain('No issues');
  });
});

describe('artel issue resolve and reopen', () => {
  it('marks an issue resolved and says so', async () => {
    api = await startFakeIssueServer([fakeIssue({ id: '5', status: 'OPEN' })]);
    const sink = createMemorySink();

    await runIssueStatusChange('5', 'resolve', { json: true }, sink, envOf());

    const payload = sink.lastJson<IssueStatusChangePayload>();
    expect(payload).toMatchObject({ issueId: '5', action: 'resolve', status: 'RESOLVED' });
    expect(api.requests.at(-1)?.url).toBe('/api/issues/5/resolve');
  });

  it('reopens an issue', async () => {
    api = await startFakeIssueServer([fakeIssue({ id: '5', status: 'RESOLVED' })]);
    const sink = createMemorySink();

    await runIssueStatusChange('5', 'reopen', { json: true }, sink, envOf());

    expect(sink.lastJson<IssueStatusChangePayload>().status).toBe('OPEN');
    expect(api.requests.at(-1)?.url).toBe('/api/issues/5/reopen');
  });

  it('names the issue when the server does not know it', async () => {
    api = await startFakeIssueServer([]);

    const failure = (await runIssueStatusChange(
      '999',
      'resolve',
      { json: true },
      createMemorySink(),
      envOf(),
    ).catch((error: unknown) => error)) as CliError;

    expect(failure.code).toBe('issue_not_found');
    expect(failure.message).toContain('999');
  });
});

/**
 * 두 명령의 키 집합은 공개 계약이다. 필드를 지우거나 이름을 바꾸면 이 테스트가 반드시 깨진다.
 */
describe('--json key sets', () => {
  const ISSUE_LIST_KEYS = ['hasMore', 'items', 'nextBeforeId'];
  const ISSUE_KEYS = [
    'id',
    'qaRunId',
    'qaTryId',
    'reportedAt',
    'resolvedAt',
    'severity',
    'status',
    'title',
  ];
  const ISSUE_STATUS_CHANGE_KEYS = ['action', 'issueId', 'status'];

  it('issue list emits exactly its contracted keys', async () => {
    api = await startFakeIssueServer([fakeIssue()]);
    const sink = createMemorySink();

    await runIssueList({ json: true, project: '1', limit: 50 }, sink, envOf());

    const payload = sink.lastJson<IssueListPayload>();
    expect(Object.keys(payload).sort()).toEqual(ISSUE_LIST_KEYS);
    expect(Object.keys(payload.items[0] ?? {}).sort()).toEqual(ISSUE_KEYS);
  });

  it('issue resolve emits exactly its contracted keys', async () => {
    api = await startFakeIssueServer([fakeIssue({ id: '5' })]);
    const sink = createMemorySink();

    await runIssueStatusChange('5', 'resolve', { json: true }, sink, envOf());

    expect(Object.keys(sink.lastJson<IssueStatusChangePayload>()).sort()).toEqual(
      ISSUE_STATUS_CHANGE_KEYS,
    );
  });
});
