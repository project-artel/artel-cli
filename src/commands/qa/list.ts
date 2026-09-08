import type { FetchLike } from '../../http/client.js';
import { listQaTries, type QaTry } from '../../http/qa.js';
import type { QaListPayload, QaTrySummaryPayload } from '../../output/contract.js';
import { writeJsonPayload, type OutputSink } from '../../output/envelope.js';
import { resolveQaContext } from '../../qa/context.js';

export interface QaListCommandOptions {
  json: boolean;
  project: string;
  limit: number;
  /** 받은 목록 안에서만 거른다. 서버에 상태 filter 가 없다. */
  status?: string | undefined;
  apiUrl?: string | undefined;
}

/**
 * 지난 시도를 다시 찾는 자리. `qa show` 가 받는 것은 run id 이므로 각 줄이 `qaRunId` 를 함께
 * 낸다 — 그것이 없으면 목록에서 본 것을 다시 열 수 없다.
 *
 * 읽기이므로 판정과 무관하게 exit 0 이다. `qa show` 와 같은 규칙이다.
 */
export async function runQaList(
  options: QaListCommandOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: FetchLike,
): Promise<void> {
  const context = await resolveQaContext(env, options.apiUrl);
  const fetched = await listQaTries(
    context.apiBaseUrl,
    context.cliToken,
    options.project,
    options.limit,
    fetchImpl,
  );

  const wanted = options.status?.toUpperCase();
  const items = wanted === undefined ? fetched : fetched.filter((item) => item.status === wanted);

  const payload: QaListPayload = {
    items: items.map(toSummary),
    /**
     * 서버에서 받은 개수. `items` 와 다르면 `--status` 가 걸러 낸 것이다. 두 수를 함께 내는
     * 이유는 이 filter 가 프로젝트 전체가 아니라 받은 것에만 걸리기 때문이다.
     */
    fetched: fetched.length,
    limit: options.limit,
    statusFilter: options.status ?? null,
  };

  if (options.json) {
    writeJsonPayload(sink, payload);
    return;
  }
  printQaList(sink, options.project, payload);
}

function toSummary(item: QaTry): QaTrySummaryPayload {
  return {
    id: item.id,
    qaRunId: item.qaRunId,
    testScenarioId: item.testScenarioId,
    gameInstanceId: item.gameInstanceId,
    status: item.status,
    startedAt: item.startedAt,
    completedAt: item.completedAt,
    model: item.model,
    promptVersion: item.promptVersion,
    reasoningEffort: item.reasoningEffort,
    agentArch: item.agentArch,
  };
}

const STATUS_WIDTH = 10;

function printQaList(sink: OutputSink, projectId: string, payload: QaListPayload): void {
  if (payload.fetched === 0) {
    sink.out(`No QA tries in project ${projectId}.`);
    return;
  }

  if (payload.items.length === 0) {
    sink.out(
      `None of the ${String(payload.fetched)} most recent tries in project ${projectId} is ${payload.statusFilter ?? ''}.`,
    );
    printFilterCaveat(sink, payload);
    return;
  }

  sink.out(`${String(payload.items.length)} QA try(s) in project ${projectId}, newest first.`);
  for (const item of payload.items) {
    // run id 를 try id 바로 다음에 둔다. 이 목록을 읽는 이유가 `qa show <run id>` 로 가기
    // 위해서이고, 그 명령이 받는 것은 try id 가 아니다.
    const run = item.qaRunId === null ? 'no run' : `run ${item.qaRunId}`;
    const axes = [item.model, item.promptVersion, item.reasoningEffort]
      .filter((value): value is string => value !== null)
      .join(' ');
    sink.out(
      `  ${item.id.padStart(6)}  ${run.padEnd(12)}  ${item.status.padEnd(STATUS_WIDTH)}  ${item.startedAt}  ${axes}`,
    );
  }
  printFilterCaveat(sink, payload);
}

/**
 * filter 가 무엇에 걸렸는지 말한다. 서버에 상태 filter 가 없어 CLI 는 받은 것 안에서만 거르고,
 * 그 차이를 감추면 사용자는 더 오래된 런이 없다고 읽는다.
 */
function printFilterCaveat(sink: OutputSink, payload: QaListPayload): void {
  if (payload.statusFilter === null) {
    return;
  }
  sink.out(
    `Filtered the ${String(payload.fetched)} most recent tries this project has, not all of them — the server has no status filter. Raise --limit to look further back.`,
  );
}
