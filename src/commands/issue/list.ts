import type { FetchLike } from '../../http/client.js';
import { listProjectIssues, type ProjectIssue } from '../../http/issues.js';
import { resolveIssueContext } from '../../issue/context.js';
import type { IssueListPayload, IssuePayload } from '../../output/contract.js';
import { writeJsonPayload, type OutputSink } from '../../output/envelope.js';

export interface IssueListCommandOptions {
  json: boolean;
  project: string;
  limit: number;
  /** 서버 filter 다. 프로젝트 전체에 걸린다. */
  status?: string | undefined;
  severity?: string | undefined;
  /** 최신순 커서. 앞 페이지가 낸 `nextBeforeId` 를 그대로 준다. */
  before?: string | undefined;
  apiUrl?: string | undefined;
}

/**
 * QA 가 찾은 결함을 프로젝트 단위로 읽는다. Jira 이슈가 아니다.
 *
 * 읽기이므로 결과가 비어 있어도 exit 0 이다.
 */
export async function runIssueList(
  options: IssueListCommandOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: FetchLike,
): Promise<void> {
  const context = await resolveIssueContext(env, options.apiUrl);
  const page = await listProjectIssues(
    context.apiBaseUrl,
    context.cliToken,
    options.project,
    {
      size: options.limit,
      ...(options.status === undefined ? {} : { status: options.status }),
      ...(options.severity === undefined ? {} : { severity: options.severity }),
      ...(options.before === undefined ? {} : { beforeId: options.before }),
    },
    fetchImpl,
  );

  const payload: IssueListPayload = {
    items: page.items.map(toIssuePayload),
    nextBeforeId: page.nextBeforeId,
    hasMore: page.hasMore,
  };

  if (options.json) {
    writeJsonPayload(sink, payload);
    return;
  }
  printIssueList(sink, options.project, payload);
}

function toIssuePayload(issue: ProjectIssue): IssuePayload {
  return {
    id: issue.id,
    qaTryId: issue.qaTryId,
    qaRunId: issue.qaRunId,
    severity: issue.severity,
    title: issue.title,
    status: issue.status,
    reportedAt: issue.reportedAt,
    resolvedAt: issue.resolvedAt,
  };
}

const SEVERITY_WIDTH = 10;
const STATUS_WIDTH = 9;

function printIssueList(sink: OutputSink, projectId: string, payload: IssueListPayload): void {
  if (payload.items.length === 0) {
    sink.out(`No issues in project ${projectId} match.`);
    return;
  }

  sink.out(`${String(payload.items.length)} issue(s) in project ${projectId}, newest first.`);
  for (const issue of payload.items) {
    sink.out(
      `  ${issue.id.padStart(6)}  ${issue.severity.padEnd(SEVERITY_WIDTH)}  ${issue.status.padEnd(STATUS_WIDTH)}  ${issue.title}`,
    );
    // 어느 런이 찾았는지를 붙인다. 그것이 없으면 `qa show` 로 문맥을 열 수 없다.
    sink.out(`      run ${issue.qaRunId ?? '-'}  try ${issue.qaTryId}  ${issue.reportedAt}`);
  }

  // 커서를 감추지 않는다. 받은 것이 전부인 줄 알면 없는 이슈를 없다고 읽는다.
  if (payload.hasMore && payload.nextBeforeId !== null) {
    sink.out(`More. Pass --before ${payload.nextBeforeId}.`);
  }
}
