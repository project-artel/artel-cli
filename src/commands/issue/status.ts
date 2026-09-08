import type { FetchLike } from '../../http/client.js';
import { setIssueStatus } from '../../http/issues.js';
import { resolveIssueContext } from '../../issue/context.js';
import type { IssueStatusChangePayload } from '../../output/contract.js';
import { writeJsonPayload, type OutputSink } from '../../output/envelope.js';

export interface IssueStatusCommandOptions {
  json: boolean;
  apiUrl?: string | undefined;
}

/**
 * 이슈를 해결로 표시하거나 그 표시를 취소한다.
 *
 * 서버가 본문 없는 204 를 내므로 payload 는 CLI 가 아는 사실만 싣는다 — 어느 이슈에 어느
 * 명령을 걸었고 그것이 성공했다는 것. 바뀐 이슈를 되읽어 오는 경로가 서버에 없어서, 이슈
 * 객체를 지어내면 그것이 실제 상태라고 읽힌다.
 */
export async function runIssueStatusChange(
  issueId: string,
  action: 'resolve' | 'reopen',
  options: IssueStatusCommandOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: FetchLike,
): Promise<void> {
  const context = await resolveIssueContext(env, options.apiUrl);
  await setIssueStatus(context.apiBaseUrl, context.cliToken, issueId, action, fetchImpl);

  const payload: IssueStatusChangePayload = {
    issueId,
    action,
    /** 서버가 상태를 되돌려주지 않으므로 이것은 요청이 성공했다는 뜻이지 되읽은 값이 아니다. */
    status: action === 'resolve' ? 'RESOLVED' : 'OPEN',
  };

  if (options.json) {
    writeJsonPayload(sink, payload);
    return;
  }
  sink.out(
    action === 'resolve'
      ? `Marked issue ${issueId} resolved.`
      : `Reopened issue ${issueId}; it counts as open again.`,
  );
}
