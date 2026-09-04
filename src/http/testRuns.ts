import { CliError } from '../errors.js';
import type { FetchLike } from './client.js';
import type { HttpFailure } from './errors.js';
import { asArray, asNullableString, asNumber, asObject, asString, requestJson } from './json.js';

/**
 * `TestRunController`(orchestration `testrun/controller/TestRunController.kt`)가 여는
 * `/api/projects/{projectId}/test-runs` 계열. 이 CLI 는 작성 챗봇(`/chat/**`)은 다루지 않는다 —
 * console 의 대화형 저작 흐름이고, 이 CLI 가 다루는 것은 이미 만들어진 test run 을 CRUD 하고
 * 시나리오 조합을 읽고 바꾸는 것뿐이다.
 */
function testRunsBasePath(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/test-runs`;
}

/** `TestRunResponse`. id 계열은 서버가 64bit 정밀도 손실을 피하려고 문자열로 낸다. */
export interface TestRun {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  createdAt: string;
}

/** `RunScenarioItem`. `position` 이 곧 실행 순서다. */
export interface RunScenarioItem {
  position: number;
  testScenarioId: string;
}

/** `RunScenariosResponse`. */
export interface RunScenarios {
  testRunId: string;
  items: RunScenarioItem[];
}

/** `RunDeletionPreview`(ARTEL-487). 지우기 전에 무엇이 같이 없어지는지 미리 센 값. */
export interface RunDeletionPreview {
  testRunId: string;
  scenarioCount: number;
  removableScenarioCount: number;
  keptForQaHistoryCount: number;
}

/** `RunDeletionResult`. 실제로 지운 뒤의 값 — preview 의 예고와 다를 수 있다(그 사이 상태가 바뀌었을 수 있어서). */
export interface RunDeletionResult {
  deletedScenarioCount: number;
  keptForQaHistoryCount: number;
}

/**
 * 이 endpoint 들이 던지는 400 은 전부 서버의 `BadRequestException` 기본 code(`invalid_request`)
 * 를 쓴다 — 세부 사유는 code 가 아니라 message 로만 갈린다(`ApiExceptionHandler` 는 4xx 는
 * message 를 그대로 클라이언트에 준다). 그래서 CLI 도 code 하나로 받고 message 를 그대로 싣는다.
 */
function invalidRequest(endpoint: string, failure: HttpFailure): CliError {
  return new CliError(
    'run_invalid_request',
    failure.message === null ? `${endpoint} rejected the request.` : failure.message,
  );
}

/**
 * `notFound()` 로 답하는 endpoint 들의 공통 실패. 서버는 이때 body 를 아예 비워 보내므로
 * `failure.code` 가 아니라 status 로만 가른다(`qa_run_not_found` 와 같은 패턴).
 */
function notFoundFailure(runId: string): (failure: HttpFailure) => CliError | null {
  return (failure) =>
    failure.status === 404
      ? new CliError('run_not_found', `There is no test run ${runId}, or you cannot see it.`)
      : null;
}

export async function listTestRuns(
  apiBaseUrl: string,
  cliToken: string,
  projectId: string,
  fetchImpl?: FetchLike,
): Promise<TestRun[]> {
  const endpoint = `${apiBaseUrl}${testRunsBasePath(projectId)}`;
  const body = await requestJson({
    method: 'GET',
    endpoint,
    cliToken,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });
  const list = asObject(body, 'body', endpoint);
  return asArray(list['items'], 'items', endpoint).map((item, index) =>
    parseTestRun(item, `items[${String(index)}]`, endpoint),
  );
}

export interface CreateTestRunRequest {
  name: string;
  description?: string | undefined;
}

export async function createTestRun(
  apiBaseUrl: string,
  cliToken: string,
  projectId: string,
  request: CreateTestRunRequest,
  fetchImpl?: FetchLike,
): Promise<TestRun> {
  const endpoint = `${apiBaseUrl}${testRunsBasePath(projectId)}`;
  const body = await requestJson({
    method: 'POST',
    endpoint,
    cliToken,
    body: request,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    onFailure: (failure) => {
      if (failure.status === 400) {
        return invalidRequest(endpoint, failure);
      }
      // project 에 참여하지 않은 사용자에게는 존재를 감추려고 서버가 404 를 낸다(`accessible`
      // 과 같은 규율). "project 를 찾을 수 없다" 가 아니라 "그 project 에서 만들 수 없다" 로 읽는다.
      if (failure.status === 404) {
        return new CliError(
          'run_not_found',
          `Cannot create a test run in project ${projectId}: it does not exist, or you are not a member.`,
        );
      }
      return null;
    },
  });
  return parseTestRun(body, 'body', endpoint);
}

export async function getTestRun(
  apiBaseUrl: string,
  cliToken: string,
  projectId: string,
  runId: string,
  fetchImpl?: FetchLike,
): Promise<TestRun> {
  const endpoint = `${apiBaseUrl}${testRunsBasePath(projectId)}/${encodeURIComponent(runId)}`;
  const body = await requestJson({
    method: 'GET',
    endpoint,
    cliToken,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    onFailure: notFoundFailure(runId),
  });
  return parseTestRun(body, 'body', endpoint);
}

export interface UpdateTestRunRequest {
  name?: string | undefined;
  description?: string | undefined;
}

export async function updateTestRun(
  apiBaseUrl: string,
  cliToken: string,
  projectId: string,
  runId: string,
  request: UpdateTestRunRequest,
  fetchImpl?: FetchLike,
): Promise<TestRun> {
  const endpoint = `${apiBaseUrl}${testRunsBasePath(projectId)}/${encodeURIComponent(runId)}`;
  const body = await requestJson({
    method: 'PUT',
    endpoint,
    cliToken,
    body: request,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    onFailure: notFoundFailure(runId),
  });
  return parseTestRun(body, 'body', endpoint);
}

/** `GET /{runId}/deletion-preview`. `run delete` 가 실제로 지우기 전에 반드시 먼저 부른다. */
export async function getRunDeletionPreview(
  apiBaseUrl: string,
  cliToken: string,
  projectId: string,
  runId: string,
  fetchImpl?: FetchLike,
): Promise<RunDeletionPreview> {
  const endpoint = `${apiBaseUrl}${testRunsBasePath(projectId)}/${encodeURIComponent(runId)}/deletion-preview`;
  const body = await requestJson({
    method: 'GET',
    endpoint,
    cliToken,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    onFailure: notFoundFailure(runId),
  });
  const preview = asObject(body, 'body', endpoint);
  return {
    testRunId: asString(preview['testRunId'], 'testRunId', endpoint),
    scenarioCount: asNumber(preview['scenarioCount'], 'scenarioCount', endpoint),
    removableScenarioCount: asNumber(
      preview['removableScenarioCount'],
      'removableScenarioCount',
      endpoint,
    ),
    keptForQaHistoryCount: asNumber(
      preview['keptForQaHistoryCount'],
      'keptForQaHistoryCount',
      endpoint,
    ),
  };
}

/**
 * `DELETE /{runId}?dropScenarios=`. QA 실행 이력이 있는 런은 409(`run_has_qa_history`) 로
 * 거절된다 — `qa_run.test_run_id` 가 cascade 없는 외래키라 서버가 미리 막는다.
 */
export async function deleteTestRun(
  apiBaseUrl: string,
  cliToken: string,
  projectId: string,
  runId: string,
  dropScenarios: boolean,
  fetchImpl?: FetchLike,
): Promise<RunDeletionResult> {
  const endpoint = `${apiBaseUrl}${testRunsBasePath(projectId)}/${encodeURIComponent(runId)}?dropScenarios=${String(dropScenarios)}`;
  const body = await requestJson({
    method: 'DELETE',
    endpoint,
    cliToken,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    onFailure: (failure) => {
      if (failure.code === 'run_has_qa_history') {
        return new CliError(
          'run_has_qa_history',
          failure.message ??
            `Test run ${runId} has QA runs recorded against it, so it cannot be deleted. Clean up those QA runs first.`,
        );
      }
      return null;
    },
  });
  const result = asObject(body, 'body', endpoint);
  return {
    deletedScenarioCount: asNumber(
      result['deletedScenarioCount'],
      'deletedScenarioCount',
      endpoint,
    ),
    keptForQaHistoryCount: asNumber(
      result['keptForQaHistoryCount'],
      'keptForQaHistoryCount',
      endpoint,
    ),
  };
}

export async function getRunScenarios(
  apiBaseUrl: string,
  cliToken: string,
  projectId: string,
  runId: string,
  fetchImpl?: FetchLike,
): Promise<RunScenarios> {
  const endpoint = `${apiBaseUrl}${testRunsBasePath(projectId)}/${encodeURIComponent(runId)}/scenarios`;
  const body = await requestJson({
    method: 'GET',
    endpoint,
    cliToken,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    onFailure: notFoundFailure(runId),
  });
  return parseRunScenarios(body, endpoint);
}

/**
 * `PUT /{runId}/scenarios`. 전체 교체다 — `scenarioIds` 의 순서가 곧 `position` 이 된다.
 * `run scenarios --set` 이 이것을 그대로 부른다: 부분 추가는 이 모듈에 없다(이유는
 * `commands/run/scenarios.ts` 상단 주석).
 */
export async function setRunScenarios(
  apiBaseUrl: string,
  cliToken: string,
  projectId: string,
  runId: string,
  scenarioIds: string[],
  fetchImpl?: FetchLike,
): Promise<RunScenarios> {
  const endpoint = `${apiBaseUrl}${testRunsBasePath(projectId)}/${encodeURIComponent(runId)}/scenarios`;
  const body = await requestJson({
    method: 'PUT',
    endpoint,
    cliToken,
    body: { scenarioIds },
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    onFailure: (failure) => {
      if (failure.status === 400) {
        return invalidRequest(endpoint, failure);
      }
      return notFoundFailure(runId)(failure);
    },
  });
  return parseRunScenarios(body, endpoint);
}

function parseTestRun(value: unknown, field: string, endpoint: string): TestRun {
  const run = asObject(value, field, endpoint);
  return {
    id: asString(run['id'], `${field}.id`, endpoint),
    projectId: asString(run['projectId'], `${field}.projectId`, endpoint),
    name: asString(run['name'], `${field}.name`, endpoint),
    description: asNullableString(run['description'], `${field}.description`, endpoint),
    createdAt: asString(run['createdAt'], `${field}.createdAt`, endpoint),
  };
}

function parseRunScenarios(body: unknown, endpoint: string): RunScenarios {
  const scenarios = asObject(body, 'body', endpoint);
  return {
    testRunId: asString(scenarios['testRunId'], 'testRunId', endpoint),
    items: asArray(scenarios['items'], 'items', endpoint).map((item, index) => {
      const field = `items[${String(index)}]`;
      const row = asObject(item, field, endpoint);
      return {
        position: asNumber(row['position'], `${field}.position`, endpoint),
        testScenarioId: asString(row['testScenarioId'], `${field}.testScenarioId`, endpoint),
      };
    }),
  };
}
