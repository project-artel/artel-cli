import { CliError } from '../errors.js';
import type { FetchLike } from './client.js';
import { parseHttpFailure, toCliError } from './errors.js';
import { asArray, asNullableString, asNumber, asObject, requestJson } from './json.js';

export const SCENARIO_PATH = '/api/test-scenario';

export function projectScenarioListPath(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/test-scenario`;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * `ScenarioStep`(orchestration `testscenario/dto/ScenarioModels.kt`)에서 CLI 가 쓰는 필드만.
 *
 * 서버 응답에는 저작 챗봇 전용 필드(`stepSource`, `stepKind` 등)도 함께 오지만, CLI 는 Agent
 * 계약(`QaStep`, artel-agent-server `app/qa/schemas.py`)이 읽는 넷만 다룬다 — 나머지는 파싱하지
 * 않고 흘려보낸다. `caseId` 는 wire 에서 `case_id` 다.
 */
export interface ScenarioStep {
  action: string;
  caseId: number | null;
  hint: string | null;
  input: string | null;
  expectedPassed: boolean | null;
}

/** `ScenarioDraft`. `steps` 는 실행 순서 그대로다. */
export interface ScenarioDraft {
  title: string;
  description: string;
  steps: ScenarioStep[];
}

/** `ScenarioResponse`. */
export interface Scenario {
  scenarioId: string;
  projectId: string;
  draft: ScenarioDraft;
}

/** `ScenarioSummary`. 목록 화면은 스텝을 역직렬화하지 않으므로 CLI 도 여기서는 스텝을 모른다. */
export interface ScenarioSummary {
  scenarioId: string;
  projectId: string;
  title: string;
  createdAt: string | null;
  updatedAt: string | null;
}

/**
 * `steps` 항목 하나가 서버로 나가는 그대로의 모양(wire). `parseScenarioSteps`
 * (`src/scenario/validate.ts`)가 사용자 입력을 이 모양으로 검증해 낸다 — 여기서 다시
 * 바꾸지 않고 그대로 요청 본문에 싣는다.
 */
export interface ScenarioStepInput {
  action: string;
  case_id: number | null;
  hint: string | null;
  input: string | null;
}

export interface ScenarioDraftInput {
  title: string;
  description: string;
  steps: ScenarioStepInput[];
}

/** `expected-labels` 항목 하나가 서버로 나가는 그대로의 모양(wire). */
export interface ExpectedLabelInput {
  step: number;
  expected_passed: boolean | null;
}

/**
 * 읽어 온 [ScenarioStep] 을 다시 보낼 [ScenarioStepInput] 으로 되접는다. `scenario update` 가
 * 스텝을 건드리지 않을 때 기존 스텝을 그대로 실어 보내는 데 쓴다.
 *
 * `expectedPassed` 는 여기서 잘려 나간다 — `ScenarioStepInput` 에 그 필드가 없다. 잃는 것은
 * 아니다: `ExpectedLabelPolicy.carryOver` 가 같은 자리에 남은 스텝(같은 action·caseId)의
 * 기존 라벨을 서버에서 다시 얹으므로, 보내는 쪽이 라벨을 몰라도 라벨은 살아남는다.
 */
export function toStepInput(step: ScenarioStep): ScenarioStepInput {
  return { action: step.action, case_id: step.caseId, hint: step.hint, input: step.input };
}

/** `POST /api/test-scenario`. 빈 시나리오를 만들고 id 만 돌려준다 — 본문은 뒤이은 update 가 싣는다. */
export async function createScenario(
  apiBaseUrl: string,
  cliToken: string,
  projectId: string,
  fetchImpl?: FetchLike,
): Promise<{ scenarioId: string }> {
  const endpoint = `${apiBaseUrl}${SCENARIO_PATH}`;
  const body = await requestJson({
    method: 'POST',
    endpoint,
    cliToken,
    body: { projectId: toWireId(projectId) },
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    onFailure: (failure) =>
      failure.status === 404
        ? new CliError(
            'scenario_project_not_found',
            `There is no project ${projectId}, or you cannot see it.`,
          )
        : null,
  });
  const record = asObject(body, 'body', endpoint);
  return { scenarioId: asIdString(record['testScenarioId'], 'testScenarioId', endpoint) };
}

/** `GET /api/test-scenario/{id}`. */
export async function getScenario(
  apiBaseUrl: string,
  cliToken: string,
  scenarioId: string,
  fetchImpl?: FetchLike,
): Promise<Scenario> {
  const endpoint = `${apiBaseUrl}${SCENARIO_PATH}/${encodeURIComponent(scenarioId)}`;
  const body = await requestJson({
    method: 'GET',
    endpoint,
    cliToken,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    onFailure: (failure) => scenarioNotFoundOrNull(failure.status, scenarioId),
  });
  return parseScenario(body, endpoint);
}

/**
 * `PUT /api/test-scenario/{id}`. `draft` 를 통째로 덮어쓴다(last-write-wins) — 서버가 이미
 * 저장돼 있던 `expectedPassed` 를 실어 되돌려주므로, 이 함수는 라벨을 지우지 않는다.
 */
export async function updateScenario(
  apiBaseUrl: string,
  cliToken: string,
  scenarioId: string,
  draft: ScenarioDraftInput,
  fetchImpl?: FetchLike,
): Promise<Scenario> {
  const endpoint = `${apiBaseUrl}${SCENARIO_PATH}/${encodeURIComponent(scenarioId)}`;
  const body = await requestJson({
    method: 'PUT',
    endpoint,
    cliToken,
    body: { draft },
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    onFailure: (failure) => scenarioNotFoundOrNull(failure.status, scenarioId),
  });
  return parseScenario(body, endpoint);
}

/** `PUT /api/test-scenario/{id}/expected-labels`. 본문을 건드리지 않는 유일한 라벨 쓰기 경로. */
export async function updateExpectedLabels(
  apiBaseUrl: string,
  cliToken: string,
  scenarioId: string,
  labels: ExpectedLabelInput[],
  fetchImpl?: FetchLike,
): Promise<Scenario> {
  const endpoint = `${apiBaseUrl}${SCENARIO_PATH}/${encodeURIComponent(scenarioId)}/expected-labels`;
  const body = await requestJson({
    method: 'PUT',
    endpoint,
    cliToken,
    body: { labels },
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    onFailure: (failure) => scenarioNotFoundOrNull(failure.status, scenarioId),
  });
  return parseScenario(body, endpoint);
}

/**
 * `POST /api/test-scenario/{id}/approve`. 성공 본문은 JSON 이 아니라 `"승인 완료"` 라는
 * 평문이라 `requestJson` 을 쓰지 않는다 — 그 함수는 성공한 본문을 항상 JSON 으로 파싱하려 든다.
 *
 * 서버는 승인 여부를 저장하지 않는다 — 최종 draft 를 한 번 더 저장할 뿐이다(draft 를 주지
 * 않으면 마지막으로 저장된 값을 그대로 둔다). 그래서 이 CLI 는 draft 를 다시 보내지 않는다:
 * `create`/`update` 가 이미 서버에 반영한 본문을 승인 한 번으로 또 보낼 이유가 없다.
 */
export async function approveScenario(
  apiBaseUrl: string,
  cliToken: string,
  scenarioId: string,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<void> {
  const endpoint = `${apiBaseUrl}${SCENARIO_PATH}/${encodeURIComponent(scenarioId)}/approve`;

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${cliToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    throw new CliError(
      'network_error',
      `Could not reach ${endpoint}: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }

  if (response.ok) {
    return;
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    text = '';
  }
  const failure = parseHttpFailure(response.status, text);
  const notFound = scenarioNotFoundOrNull(failure.status, scenarioId);
  throw notFound ?? toCliError(endpoint, failure);
}

/** `DELETE /api/test-scenario/{id}`. */
export async function deleteScenario(
  apiBaseUrl: string,
  cliToken: string,
  scenarioId: string,
  force: boolean,
  fetchImpl?: FetchLike,
): Promise<void> {
  const endpoint = `${apiBaseUrl}${SCENARIO_PATH}/${encodeURIComponent(scenarioId)}${force ? '?force=true' : ''}`;
  await requestJson({
    method: 'DELETE',
    endpoint,
    cliToken,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    onFailure: (failure) => {
      const notFound = scenarioNotFoundOrNull(failure.status, scenarioId);
      if (notFound !== null) {
        return notFound;
      }
      if (failure.status === 409) {
        return new CliError(
          'scenario_has_qa_history',
          `Test scenario ${scenarioId} has QA runs on it, so it is kept by default. Re-run with --force to delete that history along with it.`,
        );
      }
      return null;
    },
  });
}

/** `GET /api/projects/{projectId}/test-scenario`. */
export async function listScenarios(
  apiBaseUrl: string,
  cliToken: string,
  projectId: string,
  fetchImpl?: FetchLike,
): Promise<ScenarioSummary[]> {
  const endpoint = `${apiBaseUrl}${projectScenarioListPath(projectId)}`;
  const body = await requestJson({
    method: 'GET',
    endpoint,
    cliToken,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    onFailure: (failure) =>
      failure.status === 404
        ? new CliError(
            'scenario_project_not_found',
            `There is no project ${projectId}, or you cannot see it.`,
          )
        : null,
  });
  const page = asObject(body, 'body', endpoint);
  return asArray(page['items'], 'items', endpoint).map((item, index) =>
    parseScenarioSummary(item, `items[${String(index)}]`, endpoint),
  );
}

function scenarioNotFoundOrNull(status: number, scenarioId: string): CliError | null {
  return status === 404
    ? new CliError(
        'scenario_not_found',
        `There is no test scenario ${scenarioId}, or you cannot see it.`,
      )
    : null;
}

/** `projectId` 는 요청 본문에서 JSON 숫자다(`CreateScenarioRequest.projectId: Long`). */
function toWireId(id: string): number {
  const parsed = Number(id);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CliError('scenario_project_not_found', `"${id}" is not a valid project id.`);
  }
  return parsed;
}

/**
 * `testScenarioId`/`projectId` 는 서버 응답에서 JSON 숫자로 온다(`ScenarioResponse` 의
 * 둘 다 `Long` 이고, QA 도메인과 달리 문자열로 변환되지 않는다). CLI 의 다른 id 필드와
 * 모양을 맞추려고 여기서 문자열로 접는다.
 */
function asIdString(value: unknown, field: string, endpoint: string): string {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return String(asNumber(value, field, endpoint));
}

function parseScenario(body: unknown, endpoint: string): Scenario {
  const record = asObject(body, 'body', endpoint);
  const payload = asObject(record['payload'], 'payload', endpoint);
  return {
    scenarioId: asIdString(record['testScenarioId'], 'testScenarioId', endpoint),
    projectId: asIdString(record['projectId'], 'projectId', endpoint),
    draft: {
      title: typeof payload['title'] === 'string' ? payload['title'] : '',
      description: typeof payload['description'] === 'string' ? payload['description'] : '',
      steps: asArray(payload['steps'] ?? [], 'payload.steps', endpoint).map((item, index) =>
        parseScenarioStep(item, `payload.steps[${String(index)}]`, endpoint),
      ),
    },
  };
}

function parseScenarioStep(value: unknown, field: string, endpoint: string): ScenarioStep {
  const step = asObject(value, field, endpoint);
  return {
    action: typeof step['action'] === 'string' ? step['action'] : '',
    caseId: readNullableId(step['case_id'], `${field}.case_id`, endpoint),
    hint: asNullableString(step['hint'], `${field}.hint`, endpoint),
    input: asNullableString(step['input'], `${field}.input`, endpoint),
    expectedPassed: readNullableBoolean(
      step['expected_passed'],
      `${field}.expected_passed`,
      endpoint,
    ),
  };
}

function parseScenarioSummary(value: unknown, field: string, endpoint: string): ScenarioSummary {
  const summary = asObject(value, field, endpoint);
  return {
    scenarioId: asIdString(summary['testScenarioId'], `${field}.testScenarioId`, endpoint),
    projectId: asIdString(summary['projectId'], `${field}.projectId`, endpoint),
    title: typeof summary['title'] === 'string' ? summary['title'] : '',
    createdAt: asNullableString(summary['createdAt'], `${field}.createdAt`, endpoint),
    updatedAt: asNullableString(summary['updatedAt'], `${field}.updatedAt`, endpoint),
  };
}

function readNullableId(value: unknown, field: string, endpoint: string): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return asNumber(value, field, endpoint);
}

function readNullableBoolean(value: unknown, field: string, endpoint: string): boolean | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'boolean') {
    throw new CliError(
      'server_error',
      `${endpoint} answered with a "${field}" field that is neither a boolean nor null.`,
    );
  }
  return value;
}
