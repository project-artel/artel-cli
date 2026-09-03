import type { FetchLike } from '../../http/client.js';
import { cancelQaRun, getQaRun } from '../../http/qa.js';
import type { QaCancelPayload } from '../../output/contract.js';
import { writeJsonPayload, type OutputSink } from '../../output/envelope.js';
import { printQaCancel } from '../../output/human.js';
import { resolveQaContext } from '../../qa/context.js';

export interface QaCancelCommandOptions {
  json: boolean;
  apiUrl?: string | undefined;
}

/**
 * 도는 런을 멈춘다. 이미 끝난 런은 `qa_run_not_active` 로 거절한다 — 서버가 409 로 가르는
 * 구분을 CLI 가 "성공"으로 뭉개면, 취소했다고 믿은 사람과 실제로 돌고 있는 런이 갈린다.
 *
 * 취소한 뒤 상태를 한 번 더 읽어 보고한다. 취소는 활성 시나리오의 Agent 세션 종료까지
 * 포함하므로, 요청이 받아들여진 것과 런이 닫힌 것은 같은 순간이 아니다.
 */
export async function runQaCancel(
  qaRunId: string,
  options: QaCancelCommandOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: FetchLike,
): Promise<void> {
  const context = await resolveQaContext(env, options.apiUrl);
  await cancelQaRun(context.apiBaseUrl, context.cliToken, qaRunId, fetchImpl);
  const run = await getQaRun(context.apiBaseUrl, context.cliToken, qaRunId, fetchImpl);

  const payload: QaCancelPayload = {
    runId: run.id,
    cancelled: true,
    status: run.status,
  };

  if (options.json) {
    writeJsonPayload(sink, payload);
    return;
  }
  printQaCancel(sink, payload);
}
