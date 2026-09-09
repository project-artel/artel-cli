import { CliError } from '../errors.js';
import type { FetchLike } from './client.js';
import { asArray, asNullableString, asObject, asString, requestJson } from './json.js';

export const ISSUES_PATH = '/api/issues';

/** 서버 기본값과 같다(`ProjectIssueController.list` 의 `size`). */
export const DEFAULT_ISSUE_PAGE_SIZE = 50;

export function projectIssuesPath(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/issues`;
}

/** `IssueResponse` 에서 CLI 가 쓰는 필드만. `detail` 은 Agent payload 전체라 싣지 않는다. */
export interface ProjectIssue {
  id: string;
  qaTryId: string;
  qaRunId: string | null;
  severity: string;
  title: string;
  status: string;
  reportedAt: string;
  resolvedAt: string | null;
}

/**
 * `IssuePageResponse`. 최신순 커서 페이지다.
 *
 * `nextBeforeId` 를 그대로 든다. 커서를 감추면 받은 것이 전부인지 잘린 것인지 읽는 쪽이 알 수
 * 없고, 없는 이슈를 없다고 읽는다.
 */
export interface IssuePage {
  items: ProjectIssue[];
  nextBeforeId: string | null;
  hasMore: boolean;
}

export interface ListIssuesQuery {
  status?: string | undefined;
  severity?: string | undefined;
  beforeId?: string | undefined;
  size: number;
}

/**
 * 한 프로젝트의 이슈. `status` 와 `severity` 는 서버가 받는 filter 라 프로젝트 전체에 걸린다.
 */
export async function listProjectIssues(
  apiBaseUrl: string,
  cliToken: string,
  projectId: string,
  query: ListIssuesQuery,
  fetchImpl?: FetchLike,
): Promise<IssuePage> {
  const params = new URLSearchParams({ size: String(query.size) });
  if (query.status !== undefined) params.set('status', query.status);
  if (query.severity !== undefined) params.set('severity', query.severity);
  if (query.beforeId !== undefined) params.set('beforeId', query.beforeId);

  const endpoint = `${apiBaseUrl}${projectIssuesPath(projectId)}?${params.toString()}`;
  const body = await requestJson({
    method: 'GET',
    endpoint,
    cliToken,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });

  const page = asObject(body, 'body', endpoint);
  return {
    items: asArray(page['items'], 'items', endpoint).map((item, index) =>
      parseIssue(item, `items[${String(index)}]`, endpoint),
    ),
    nextBeforeId: asNullableString(page['nextBeforeId'], 'nextBeforeId', endpoint),
    hasMore: page['hasMore'] === true,
  };
}

/**
 * 해결로 표시하거나 그 표시를 취소한다.
 *
 * 서버가 204 를 내고 본문이 없다. 그래서 이 함수도 아무것도 돌려주지 않는다 — 바뀐 이슈를
 * 되읽어 오는 경로가 서버에 없으므로, 지어낸 이슈 객체를 돌려주면 그것이 실제 상태라고 읽힌다.
 */
export async function setIssueStatus(
  apiBaseUrl: string,
  cliToken: string,
  issueId: string,
  action: 'resolve' | 'reopen',
  fetchImpl?: FetchLike,
): Promise<void> {
  const endpoint = `${apiBaseUrl}${ISSUES_PATH}/${encodeURIComponent(issueId)}/${action}`;
  await requestJson({
    method: 'POST',
    endpoint,
    cliToken,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    onFailure: (failure) =>
      failure.status === 404
        ? new CliError('issue_not_found', `There is no issue ${issueId}, or you cannot see it.`)
        : null,
  });
}

function parseIssue(value: unknown, field: string, endpoint: string): ProjectIssue {
  const issue = asObject(value, field, endpoint);
  return {
    id: asString(issue['id'], `${field}.id`, endpoint),
    qaTryId: asString(issue['qaTryId'], `${field}.qaTryId`, endpoint),
    qaRunId: asNullableString(issue['qaRunId'], `${field}.qaRunId`, endpoint),
    severity: asString(issue['severity'], `${field}.severity`, endpoint),
    title: asString(issue['title'], `${field}.title`, endpoint),
    status: asString(issue['status'], `${field}.status`, endpoint),
    reportedAt: asString(issue['reportedAt'], `${field}.reportedAt`, endpoint),
    resolvedAt: asNullableString(issue['resolvedAt'], `${field}.resolvedAt`, endpoint),
  };
}
