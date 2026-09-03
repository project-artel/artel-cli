import type { FetchLike } from '../http/client.js';
import {
  getQaTryLogTail,
  isTerminalStatus,
  listQaTryIssues,
  type QaRun,
  type QaTry,
} from '../http/qa.js';
import type { QaIssuePayload, QaRunPayload, QaTryPayload } from '../output/contract.js';
import {
  findTerminalFrame,
  rollUpVerdict,
  sumCounts,
  UNKNOWN_COUNTS,
  type QaTerminalFrame,
} from './verdict.js';

/**
 * 종단 frame 을 찾으러 읽는 로그 페이지 크기. 서버의 stream 은 종단 frame 에서 멈춰 그 뒤로
 * frame 이 붙지 않으므로 마지막 한 페이지면 충분하고, 20 은 그 위의 여유다.
 */
const LOG_TAIL_SIZE = 20;

/** 실행 하나가 남기는 이슈 한 페이지. 서버가 허용하는 최대다. */
const ISSUE_PAGE_SIZE = 100;

/**
 * 런 하나를 `--json` payload 로 만든다. `qa run`·`qa watch`·`qa show` 가 모두 이것을 쓴다.
 *
 * 판정을 stream 이 아니라 로그에서 다시 읽는 것은 의도다: 그래야 연결이 끊겼다 이어진
 * `watch` 와, 런이 끝난 한참 뒤의 `show` 가 **같은 값**을 말한다. stream 에서 본 것을
 * 기억해 두었다가 쓰면 두 경로가 갈리고, 갈린 쪽이 어느 쪽인지는 아무도 모른다.
 */
export async function buildQaRunPayload(
  apiBaseUrl: string,
  cliToken: string,
  run: QaRun,
  fetchImpl?: FetchLike,
): Promise<QaRunPayload> {
  const tries = await Promise.all(
    run.tries.map((qaTry) => buildTryPayload(apiBaseUrl, cliToken, qaTry, fetchImpl)),
  );
  const issues = await Promise.all(
    run.tries.map((qaTry) =>
      qaTry.status === 'PENDING'
        ? Promise.resolve<QaIssuePayload[]>([])
        : readIssues(apiBaseUrl, cliToken, qaTry.id, fetchImpl),
    ),
  );

  return {
    runId: run.id,
    testRunId: run.testRunId,
    gameInstanceId: run.gameInstanceId,
    status: run.status,
    verdict: rollUpVerdict(tries.map((qaTry) => qaTry.verdict)),
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    steps: sumCounts(tries.map((qaTry) => qaTry.steps)),
    cases: sumCounts(tries.map((qaTry) => qaTry.cases)),
    tries,
    issues: issues.flat(),
  };
}

async function buildTryPayload(
  apiBaseUrl: string,
  cliToken: string,
  qaTry: QaTry,
  fetchImpl?: FetchLike,
): Promise<QaTryPayload> {
  const frame = isTerminalStatus(qaTry.status)
    ? await readTerminalFrameOf(apiBaseUrl, cliToken, qaTry.id, fetchImpl)
    : null;

  return {
    tryId: qaTry.id,
    testScenarioId: qaTry.testScenarioId,
    status: qaTry.status,
    startedAt: qaTry.startedAt,
    completedAt: qaTry.completedAt,
    model: qaTry.model,
    promptVersion: qaTry.promptVersion,
    reasoningEffort: qaTry.reasoningEffort,
    agentArch: qaTry.agentArch,
    agentFingerprint: qaTry.agentFingerprint,
    verdict: frame?.verdict ?? null,
    steps: frame?.steps ?? UNKNOWN_COUNTS,
    cases: frame?.cases ?? UNKNOWN_COUNTS,
    stepResults: frame?.stepResults ?? [],
  };
}

async function readTerminalFrameOf(
  apiBaseUrl: string,
  cliToken: string,
  qaTryId: string,
  fetchImpl?: FetchLike,
): Promise<QaTerminalFrame | null> {
  const logs = await getQaTryLogTail(apiBaseUrl, cliToken, qaTryId, LOG_TAIL_SIZE, fetchImpl);
  return findTerminalFrame(logs);
}

async function readIssues(
  apiBaseUrl: string,
  cliToken: string,
  qaTryId: string,
  fetchImpl?: FetchLike,
): Promise<QaIssuePayload[]> {
  const issues = await listQaTryIssues(apiBaseUrl, cliToken, qaTryId, ISSUE_PAGE_SIZE, fetchImpl);
  return issues.map((issue) => ({
    issueId: issue.id,
    tryId: issue.qaTryId,
    severity: issue.severity,
    title: issue.title,
    status: issue.status,
    reportedAt: issue.reportedAt,
  }));
}
