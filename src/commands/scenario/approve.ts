import type { FetchLike } from '../../http/client.js';
import { approveScenario } from '../../http/scenario.js';
import type { ScenarioApprovePayload } from '../../output/contract.js';
import { writeJsonPayload, type OutputSink } from '../../output/envelope.js';
import { printScenarioApprove } from '../../output/human.js';
import { resolveScenarioContext } from '../../scenario/context.js';

export interface ScenarioApproveCommandOptions {
  json: boolean;
  apiUrl?: string | undefined;
}

/**
 * 승인은 저장된 상태가 아니다(2026-09-03, 서버 코드로 확인) — `test_scenario` 테이블에
 * "승인됨" 필드가 없고, 승인하지 않은 시나리오도 test run 에 얹혀 QA run 을 그대로 돈다.
 * 그래서 이 명령이 하는 일은 마지막 draft 를 한 번 더 확정 저장하는 것뿐이고, 승인 여부를
 * 되읽을 방법이 서버에 없다는 사실을 사람이 읽는 출력에 그대로 적는다
 * (`printScenarioApprove`).
 */
export async function runScenarioApprove(
  scenarioId: string,
  options: ScenarioApproveCommandOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: FetchLike,
): Promise<void> {
  const context = await resolveScenarioContext(env, options.apiUrl);
  await approveScenario(context.apiBaseUrl, context.cliToken, scenarioId, fetchImpl);

  const payload: ScenarioApprovePayload = { scenarioId, approved: true };

  if (options.json) {
    writeJsonPayload(sink, payload);
    return;
  }
  printScenarioApprove(sink, payload);
}
