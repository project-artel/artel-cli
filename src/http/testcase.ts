import { CliError } from '../errors.js';
import type { FetchLike } from './client.js';
import type { HttpFailure } from './errors.js';
import { asArray, asNullableString, asObject, asString, requestJson } from './json.js';

/**
 * `TestCaseController`(orchestration `testcase/controller/TestCaseController.kt`)의 REST 경로.
 * 일괄 생성 endpoint 는 없다 — 서버는 케이스 하나짜리 `POST` 만 받는다.
 */
function testCasesPath(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/test-cases`;
}

function testCasePath(projectId: string, caseId: string): string {
  return `${testCasesPath(projectId)}/${encodeURIComponent(caseId)}`;
}

/**
 * `TestCaseResponse`(orchestration `testcase/dto/TestCaseDtos.kt`)와 같은 필드, 같은 이름.
 * `case list`·`case create`·`case update` 가 이 모양을 낸다.
 */
export interface TestCase {
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
}

/** `TestCaseDetailResponse`. [TestCase] 에 `evidenceGaps` 하나만 더 붙는다. `case show` 전용. */
export interface TestCaseDetail extends TestCase {
  evidenceGaps: string[];
}

/** `TestCaseCreateRequest`. 값은 자연어이고 셋(`scene`/`step`/`expectedValue`)은 서버가 필수로 본다. */
export interface TestCaseCreateRequest {
  scene?: string | undefined;
  step?: string | undefined;
  precondition?: string | undefined;
  expectedValue?: string | undefined;
}

/** `TestCaseUpdateRequest`. 준 필드만 반영되고, 나머지는 기존 값을 유지한다(서버 쪽 규칙). */
export interface TestCaseUpdateRequest {
  scene?: string | undefined;
  step?: string | undefined;
  precondition?: string | undefined;
  expectedValue?: string | undefined;
  verificationStatus?: string | undefined;
}

export async function listTestCases(
  apiBaseUrl: string,
  cliToken: string,
  projectId: string,
  fetchImpl?: FetchLike,
): Promise<TestCase[]> {
  const endpoint = `${apiBaseUrl}${testCasesPath(projectId)}`;
  const body = await requestJson({
    method: 'GET',
    endpoint,
    cliToken,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });
  const page = asObject(body, 'body', endpoint);
  return asArray(page['items'], 'items', endpoint).map((item, index) =>
    parseTestCase(item, `items[${String(index)}]`, endpoint),
  );
}

/** `POST /api/projects/{projectId}/test-cases`. 비참여자는 404 다(존재 자체를 숨긴다). */
export async function createTestCase(
  apiBaseUrl: string,
  cliToken: string,
  projectId: string,
  request: TestCaseCreateRequest,
  fetchImpl?: FetchLike,
): Promise<TestCase> {
  const endpoint = `${apiBaseUrl}${testCasesPath(projectId)}`;
  const body = await requestJson({
    method: 'POST',
    endpoint,
    cliToken,
    body: request,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    onFailure: (failure) => caseFailure(failure, projectId),
  });
  return parseTestCase(body, 'body', endpoint);
}

export async function getTestCase(
  apiBaseUrl: string,
  cliToken: string,
  projectId: string,
  caseId: string,
  fetchImpl?: FetchLike,
): Promise<TestCaseDetail> {
  const endpoint = `${apiBaseUrl}${testCasePath(projectId, caseId)}`;
  const body = await requestJson({
    method: 'GET',
    endpoint,
    cliToken,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    onFailure: (failure) => caseFailure(failure, projectId, caseId),
  });
  return parseTestCaseDetail(body, endpoint);
}

export async function updateTestCase(
  apiBaseUrl: string,
  cliToken: string,
  projectId: string,
  caseId: string,
  request: TestCaseUpdateRequest,
  fetchImpl?: FetchLike,
): Promise<TestCase> {
  const endpoint = `${apiBaseUrl}${testCasePath(projectId, caseId)}`;
  const body = await requestJson({
    method: 'PUT',
    endpoint,
    cliToken,
    body: request,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    onFailure: (failure) => caseFailure(failure, projectId, caseId),
  });
  return parseTestCase(body, 'body', endpoint);
}

/** `DELETE /api/projects/{projectId}/test-cases/{caseId}`. 성공은 204, 몸통이 없다. */
export async function deleteTestCase(
  apiBaseUrl: string,
  cliToken: string,
  projectId: string,
  caseId: string,
  fetchImpl?: FetchLike,
): Promise<void> {
  const endpoint = `${apiBaseUrl}${testCasePath(projectId, caseId)}`;
  await requestJson({
    method: 'DELETE',
    endpoint,
    cliToken,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    onFailure: (failure) => caseFailure(failure, projectId, caseId),
  });
}

/**
 * `case` 명령 다섯 개가 공유하는 실패 매핑. 404 는 언제나 "없거나 못 본다"(서버가 존재
 * 자체를 숨기는 규약)이고, 400 은 서버가 이미 안전한 문구로 준 것이라 그대로 옮긴다
 * (`ApiExceptionHandler`: 4xx message 는 도메인 안내라 노출해도 된다).
 */
function caseFailure(failure: HttpFailure, projectId: string, caseId?: string): CliError | null {
  if (failure.status === 404) {
    return new CliError(
      'case_not_found',
      caseId === undefined
        ? `Project ${projectId} does not exist, or you are not a member of it.`
        : `There is no test case ${caseId} in project ${projectId}, or you cannot see it.`,
    );
  }
  if (failure.status === 400) {
    return new CliError(
      'case_invalid_request',
      failure.message ?? 'The server rejected the request as invalid.',
    );
  }
  return null;
}

function parseTestCase(value: unknown, field: string, endpoint: string): TestCase {
  const item = asObject(value, field, endpoint);
  return {
    id: asString(item['id'], `${field}.id`, endpoint),
    projectId: asString(item['projectId'], `${field}.projectId`, endpoint),
    scene: asString(item['scene'], `${field}.scene`, endpoint),
    step: asString(item['step'], `${field}.step`, endpoint),
    precondition: asNullableString(item['precondition'], `${field}.precondition`, endpoint),
    expectedValue: asString(item['expectedValue'], `${field}.expectedValue`, endpoint),
    status: asNullableString(item['status'], `${field}.status`, endpoint),
    verificationStatus: asString(
      item['verificationStatus'],
      `${field}.verificationStatus`,
      endpoint,
    ),
    lastVerifiedBuildId: asNullableString(
      item['lastVerifiedBuildId'],
      `${field}.lastVerifiedBuildId`,
      endpoint,
    ),
    createdAt: asString(item['createdAt'], `${field}.createdAt`, endpoint),
  };
}

function parseTestCaseDetail(value: unknown, endpoint: string): TestCaseDetail {
  const base = parseTestCase(value, 'body', endpoint);
  const item = asObject(value, 'body', endpoint);
  return {
    ...base,
    evidenceGaps: asArray(item['evidenceGaps'], 'body.evidenceGaps', endpoint).map((entry, index) =>
      asString(entry, `body.evidenceGaps[${String(index)}]`, endpoint),
    ),
  };
}
