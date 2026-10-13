import { CliError } from '../errors.js';
import type { FetchLike } from './client.js';
import type { HttpFailure } from './errors.js';
import { asArray, asNullableString, asNumber, asObject, asString, requestJson } from './json.js';

/**
 * `TestCaseFolderController`(orchestration `testcase/controller/TestCaseFolderController.kt`)와
 * `TestCaseController` 의 `POST /move` 경로.
 */
function foldersPath(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/test-case-folders`;
}

function folderPath(projectId: string, folderId: string): string {
  return `${foldersPath(projectId)}/${encodeURIComponent(folderId)}`;
}

/**
 * `TestCaseFolderResponse` 와 같은 필드, 같은 이름. content map 이 만든 folder 가 아니면
 * `contentMapId` 와 `gameBuildId` 가 `null` 이다.
 */
export interface TestCaseFolder {
  id: string;
  parentId: string | null;
  name: string;
  contentMapId: string | null;
  gameBuildId: string | null;
}

/**
 * `TestCaseFolderRequest`. PUT 도 두 칸을 모두 받고, `parentId` 가 없으면 서버는 folder 를
 * 최상위로 옮긴다. 그래서 수정할 때도 두 값을 언제나 채워 보낸다.
 */
export interface TestCaseFolderRequest {
  name: string;
  parentId: string | null;
}

export async function listTestCaseFolders(
  apiBaseUrl: string,
  cliToken: string,
  projectId: string,
  fetchImpl?: FetchLike,
): Promise<TestCaseFolder[]> {
  const endpoint = `${apiBaseUrl}${foldersPath(projectId)}`;
  const body = await requestJson({
    method: 'GET',
    endpoint,
    cliToken,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    onFailure: (failure) => folderFailure(failure, projectId),
  });
  const page = asObject(body, 'body', endpoint);
  return asArray(page['items'], 'items', endpoint).map((item, index) =>
    parseFolder(item, `items[${String(index)}]`, endpoint),
  );
}

export async function createTestCaseFolder(
  apiBaseUrl: string,
  cliToken: string,
  projectId: string,
  request: TestCaseFolderRequest,
  fetchImpl?: FetchLike,
): Promise<TestCaseFolder> {
  const endpoint = `${apiBaseUrl}${foldersPath(projectId)}`;
  const body = await requestJson({
    method: 'POST',
    endpoint,
    cliToken,
    body: request,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    onFailure: (failure) => folderFailure(failure, projectId),
  });
  return parseFolder(body, 'body', endpoint);
}

export async function updateTestCaseFolder(
  apiBaseUrl: string,
  cliToken: string,
  projectId: string,
  folderId: string,
  request: TestCaseFolderRequest,
  fetchImpl?: FetchLike,
): Promise<TestCaseFolder> {
  const endpoint = `${apiBaseUrl}${folderPath(projectId, folderId)}`;
  const body = await requestJson({
    method: 'PUT',
    endpoint,
    cliToken,
    body: request,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    onFailure: (failure) => folderFailure(failure, projectId),
  });
  return parseFolder(body, 'body', endpoint);
}

/** 성공은 204 다. 하위 folder 는 함께 지워지고, 그 안의 test case 는 folder 없음이 된다(서버 V99). */
export async function deleteTestCaseFolder(
  apiBaseUrl: string,
  cliToken: string,
  projectId: string,
  folderId: string,
  fetchImpl?: FetchLike,
): Promise<void> {
  const endpoint = `${apiBaseUrl}${folderPath(projectId, folderId)}`;
  await requestJson({
    method: 'DELETE',
    endpoint,
    cliToken,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    onFailure: (failure) => folderFailure(failure, projectId),
  });
}

/**
 * `POST /api/projects/{projectId}/test-cases/move`. 서버가 돌려주는 `moved` 는 실제로 옮긴 행
 * 수다. 없는 id 나 다른 프로젝트의 id 는 오류 없이 세지 않으므로, 요청한 수와 다를 수 있다.
 */
export async function moveTestCases(
  apiBaseUrl: string,
  cliToken: string,
  projectId: string,
  caseIds: string[],
  folderId: string | null,
  fetchImpl?: FetchLike,
): Promise<number> {
  const endpoint = `${apiBaseUrl}/api/projects/${encodeURIComponent(projectId)}/test-cases/move`;
  const body = await requestJson({
    method: 'POST',
    endpoint,
    cliToken,
    body: { caseIds, folderId },
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    onFailure: (failure) => folderFailure(failure, projectId),
  });
  return asNumber(asObject(body, 'body', endpoint)['moved'], 'moved', endpoint);
}

/**
 * folder 명령이 공유하는 실패 매핑. 서버는 비멤버 프로젝트와 없는 folder 를 둘 다 404 로
 * 답하므로 둘을 가르지 않는다. 400 과 409 의 `message` 는 서버가 사용자에게 보여 주려고 쓴
 * 문구라 그대로 옮긴다(`ApiExceptionHandler`).
 */
function folderFailure(failure: HttpFailure, projectId: string): CliError | null {
  if (failure.status === 404) {
    return new CliError(
      'case_folder_not_found',
      `The folder does not exist in project ${projectId}, or you are not a member of the project.`,
    );
  }
  if (failure.status === 409) {
    return new CliError(
      'case_folder_conflict',
      failure.message ?? 'A folder with the same name already exists under the same parent.',
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

function parseFolder(value: unknown, field: string, endpoint: string): TestCaseFolder {
  const item = asObject(value, field, endpoint);
  return {
    id: asString(item['id'], `${field}.id`, endpoint),
    parentId: asNullableString(item['parentId'], `${field}.parentId`, endpoint),
    name: asString(item['name'], `${field}.name`, endpoint),
    contentMapId: asNullableString(item['contentMapId'], `${field}.contentMapId`, endpoint),
    gameBuildId: asNullableString(item['gameBuildId'], `${field}.gameBuildId`, endpoint),
  };
}
