import http from 'node:http';

/**
 * `scenario` endpoint 를 흉내 내는 loopback 서버. `qa-helpers.ts` 와 같은 이유로 진짜 HTTP 를
 * 쓴다 — 여기서는 특히 `approve` 의 평문 응답(“승인 완료”, JSON 이 아님)이 mock 으로는
 * 놓치기 쉬운 실제 서버 성질이다.
 */

export interface FakeScenarioStep {
  action: string;
  case_id: number | null;
  hint: string | null;
  input: string | null;
  expected_passed: boolean | null;
}

export interface FakeScenario {
  id: string;
  projectId: string;
  title: string;
  description: string;
  steps: FakeScenarioStep[];
  createdAt: string;
  updatedAt: string;
  hasQaHistory: boolean;
}

export interface FakeScenarioServerOptions {
  scenarios?: FakeScenario[];
  /** 이 프로젝트로의 목록/생성 요청은 404 로 답한다(비참여자로 흉내). */
  inaccessibleProjectIds?: string[];
  /** 주면 `PUT /api/test-scenario/{id}` (본문 저장) 이 이 status/body 로 실패한다. */
  updateFailsWith?: { status: number; body: string };
}

export interface FakeScenarioServer {
  baseUrl: string;
  scenarios: FakeScenario[];
  createBodies: unknown[];
  updateBodies: unknown[];
  labelBodies: unknown[];
  approveCalls: string[];
  close(): Promise<void>;
}

export async function startFakeScenarioServer(
  options: FakeScenarioServerOptions = {},
): Promise<FakeScenarioServer> {
  const scenarios = [...(options.scenarios ?? [])];
  const inaccessible = new Set(options.inaccessibleProjectIds ?? []);
  const createBodies: unknown[] = [];
  const updateBodies: unknown[] = [];
  const labelBodies: unknown[] = [];
  const approveCalls: string[] = [];
  let nextId = 100;

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const method = request.method ?? 'GET';

    if (method === 'POST' && url.pathname === '/api/test-scenario') {
      readBody(request, (raw) => {
        const body = JSON.parse(raw) as { projectId: number };
        createBodies.push(body);
        const projectId = String(body.projectId);
        if (inaccessible.has(projectId)) {
          send(response, 404, '');
          return;
        }
        nextId += 1;
        const id = String(nextId);
        const now = '2026-09-03T05:00:00Z';
        scenarios.push({
          id,
          projectId,
          title: '',
          description: '',
          steps: [],
          createdAt: now,
          updatedAt: now,
          hasQaHistory: false,
        });
        send(response, 200, JSON.stringify({ testScenarioId: Number(id) }));
      });
      return;
    }

    const projectListMatch = /^\/api\/projects\/([^/]+)\/test-scenario$/.exec(url.pathname);
    if (method === 'GET' && projectListMatch !== null) {
      const projectId = projectListMatch[1] ?? '';
      if (inaccessible.has(projectId)) {
        send(response, 404, '');
        return;
      }
      const items = scenarios
        .filter((scenario) => scenario.projectId === projectId)
        .map((scenario) => ({
          testScenarioId: Number(scenario.id),
          projectId: Number(scenario.projectId),
          title: scenario.title,
          createdAt: scenario.createdAt,
          updatedAt: scenario.updatedAt,
        }));
      send(response, 200, JSON.stringify({ items }));
      return;
    }

    const approveMatch = /^\/api\/test-scenario\/([^/]+)\/approve$/.exec(url.pathname);
    if (method === 'POST' && approveMatch !== null) {
      const id = approveMatch[1] ?? '';
      const scenario = scenarios.find((item) => item.id === id);
      if (scenario === undefined) {
        send(response, 404, JSON.stringify({ code: 'not_found', message: '찾을 수 없습니다.' }));
        return;
      }
      approveCalls.push(id);
      response.writeHead(200, { 'content-type': 'text/plain;charset=UTF-8' });
      response.end('승인 완료');
      return;
    }

    const labelsMatch = /^\/api\/test-scenario\/([^/]+)\/expected-labels$/.exec(url.pathname);
    if (method === 'PUT' && labelsMatch !== null) {
      const id = labelsMatch[1] ?? '';
      readBody(request, (raw) => {
        const scenario = scenarios.find((item) => item.id === id);
        if (scenario === undefined) {
          send(response, 404, JSON.stringify({ code: 'not_found', message: '찾을 수 없습니다.' }));
          return;
        }
        const body = JSON.parse(raw) as {
          labels: { step: number; expected_passed: boolean | null }[];
        };
        labelBodies.push(body);
        for (const label of body.labels) {
          const step = scenario.steps[label.step - 1];
          if (step !== undefined) {
            step.expected_passed = label.expected_passed;
          }
        }
        send(response, 200, JSON.stringify(scenarioResponse(scenario)));
      });
      return;
    }

    const scenarioMatch = /^\/api\/test-scenario\/([^/]+)$/.exec(url.pathname);
    if (method === 'GET' && scenarioMatch !== null) {
      const id = scenarioMatch[1] ?? '';
      const scenario = scenarios.find((item) => item.id === id);
      if (scenario === undefined) {
        send(response, 404, '');
        return;
      }
      send(response, 200, JSON.stringify(scenarioResponse(scenario)));
      return;
    }

    if (method === 'PUT' && scenarioMatch !== null) {
      const id = scenarioMatch[1] ?? '';
      readBody(request, (raw) => {
        const scenario = scenarios.find((item) => item.id === id);
        if (scenario === undefined) {
          send(response, 404, JSON.stringify({ code: 'not_found', message: '찾을 수 없습니다.' }));
          return;
        }
        if (options.updateFailsWith !== undefined) {
          send(response, options.updateFailsWith.status, options.updateFailsWith.body);
          return;
        }
        const body = JSON.parse(raw) as {
          draft: { title: string; description: string; steps: FakeScenarioStep[] };
        };
        updateBodies.push(body);
        const previous = scenario.steps;
        scenario.title = body.draft.title;
        scenario.description = body.draft.description;
        scenario.steps = body.draft.steps.map((incoming, index) => {
          const old = previous[index];
          const carried =
            old !== undefined && old.action === incoming.action && old.case_id === incoming.case_id
              ? old.expected_passed
              : null;
          return { ...incoming, expected_passed: carried };
        });
        scenario.updatedAt = '2026-09-03T05:10:00Z';
        send(response, 200, JSON.stringify(scenarioResponse(scenario)));
      });
      return;
    }

    if (method === 'DELETE' && scenarioMatch !== null) {
      const id = scenarioMatch[1] ?? '';
      const index = scenarios.findIndex((item) => item.id === id);
      if (index === -1) {
        send(response, 404, JSON.stringify({ code: 'not_found', message: '찾을 수 없습니다.' }));
        return;
      }
      const scenario = scenarios[index];
      const force = url.searchParams.get('force') === 'true';
      if (scenario?.hasQaHistory === true && !force) {
        send(
          response,
          409,
          JSON.stringify({
            code: 'scenario_has_qa_history',
            message: '이 시나리오에는 QA 실행 이력이 있어 삭제할 수 없습니다.',
          }),
        );
        return;
      }
      scenarios.splice(index, 1);
      response.writeHead(204);
      response.end();
      return;
    }

    send(response, 404, '{"code":"not_found","message":"no such route"}');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the fake scenario server did not bind to a TCP port');
  }

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    scenarios,
    createBodies,
    updateBodies,
    labelBodies,
    approveCalls,
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

function scenarioResponse(scenario: FakeScenario): unknown {
  return {
    testScenarioId: Number(scenario.id),
    projectId: Number(scenario.projectId),
    payload: { title: scenario.title, description: scenario.description, steps: scenario.steps },
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

export function fakeScenario(id: string, overrides: Partial<FakeScenario> = {}): FakeScenario {
  return {
    id,
    projectId: '1',
    title: 'New game story',
    description: 'Start a new game and reach the first checkpoint.',
    steps: [
      {
        action: 'click new game',
        case_id: null,
        hint: null,
        input: 'click',
        expected_passed: null,
      },
      {
        action: 'confirm the story scene appears',
        case_id: 42,
        hint: 'story-scene-root',
        input: null,
        expected_passed: true,
      },
    ],
    createdAt: '2026-09-03T04:00:00Z',
    updatedAt: '2026-09-03T04:00:00Z',
    hasQaHistory: false,
    ...overrides,
  };
}
