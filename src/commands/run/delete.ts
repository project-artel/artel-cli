import type { FetchLike } from '../../http/client.js';
import { deleteTestRun, getRunDeletionPreview } from '../../http/testRuns.js';
import type { TestRunDeletePayload } from '../../output/contract.js';
import { writeJsonPayload, type OutputSink } from '../../output/envelope.js';
import { printTestRunDelete } from '../../output/human.js';
import { resolveTestRunContext } from '../../testRuns/context.js';

export interface RunDeleteCommandOptions {
  json: boolean;
  project: string;
  /** 이 런에만 담긴 시나리오도 함께 지운다. 다른 런에도 든 것과 QA 실행 이력이 있는 것은 이 값과 무관하게 남는다. */
  dropScenarios: boolean;
  /** 있어야 실제로 지운다. 없으면 미리보기만 하고 끝난다. */
  yes: boolean;
  apiUrl?: string | undefined;
}

/**
 * test run 을 지운다. **실제로 지우기 전에 항상 무엇이 같이 없어지는지부터 센다**
 * (`GET /deletion-preview`) — 서버가 이미 그 질의를 갖고 있으므로 CLI 가 다시 계산하지
 * 않는다.
 *
 * `--yes` 없이 부르면 그 미리보기만 보여주고 실제 삭제(`DELETE`)는 부르지 않는다.
 * 되돌릴 수 없는 삭제 앞에서, 아무 입력도 받지 않은 채 표준입력을 읽어 기다리는 대신
 * (CI 에서 그 방식은 상한 없이 멈춘다 — 이 CLI 의 다른 명령 어디에도 그런 대화형 확인이
 * 없는 이유와 같다) 명시적인 플래그로 의사를 받는다. 사람은 미리보기를 보고 다시
 * `--yes` 를 붙여 부르면 되고, 스크립트는 처음부터 `--yes` 를 붙이면 된다 — 어느 쪽도
 * 명령이 멈춰서 기다리는 일이 없다.
 */
export async function runDelete(
  runId: string,
  options: RunDeleteCommandOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: FetchLike,
): Promise<void> {
  const context = await resolveTestRunContext(env, options.apiUrl);
  const preview = await getRunDeletionPreview(
    context.apiBaseUrl,
    context.cliToken,
    options.project,
    runId,
    fetchImpl,
  );

  if (!options.yes) {
    const payload: TestRunDeletePayload = {
      runId,
      dropScenarios: options.dropScenarios,
      confirmed: false,
      preview: {
        scenarioCount: preview.scenarioCount,
        removableScenarioCount: preview.removableScenarioCount,
        keptForQaHistoryCount: preview.keptForQaHistoryCount,
      },
      deletedScenarioCount: null,
      deletedKeptForQaHistoryCount: null,
    };
    report(sink, options.json, payload);
    return;
  }

  const result = await deleteTestRun(
    context.apiBaseUrl,
    context.cliToken,
    options.project,
    runId,
    options.dropScenarios,
    fetchImpl,
  );

  const payload: TestRunDeletePayload = {
    runId,
    dropScenarios: options.dropScenarios,
    confirmed: true,
    preview: {
      scenarioCount: preview.scenarioCount,
      removableScenarioCount: preview.removableScenarioCount,
      keptForQaHistoryCount: preview.keptForQaHistoryCount,
    },
    deletedScenarioCount: result.deletedScenarioCount,
    deletedKeptForQaHistoryCount: result.keptForQaHistoryCount,
  };
  report(sink, options.json, payload);
}

function report(sink: OutputSink, json: boolean, payload: TestRunDeletePayload): void {
  if (json) {
    writeJsonPayload(sink, payload);
    return;
  }
  printTestRunDelete(sink, payload);
}
