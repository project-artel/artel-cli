import type { FetchLike } from './client.js';
import { requestJson } from './json.js';

export const LLM_USAGE_QA_RUNS_PATH = '/api/llm-usage/qa-runs';

/**
 * `LlmUsageTotals`(orchestration)와 같은 모양. 전부 합계다.
 *
 * `costUsd` 가 `null` 이면 단가를 아는 호출이 하나도 없다는 뜻이고 **0 과 다르다** — 둘을 같은
 * 0 으로 그리면 비용 비교가 조용히 틀린다. `pricedCalls` 가 `calls` 보다 작으면 그 금액은 일부
 * 호출에만 얹힌 값이다.
 *
 * `cachedInputTokens` 는 `inputTokens` 에 **포함된** 값이다. 더하면 두 번 센다.
 *
 * `calls` 가 0 인 것은 "안 썼다" 가 아니라 "아직 안 왔거나 유실됐다" 일 수 있다. agent 는
 * 배치로 보내고 실패한 배치를 재시도하지 않는다.
 */
export interface LlmUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  costUsd: number | null;
  calls: number;
  pricedCalls: number;
}

/**
 * try 하나의 지출.
 *
 * 경로 이름이 `qa-runs` 인데 받는 것은 `qaTryId` 다. 지출은 run 이 아니라 try 에 귀속되고,
 * 한 run 에는 시나리오마다 try 가 있으므로 런 단위 값은 그 합이다.
 */
export async function getQaTryUsage(
  apiBaseUrl: string,
  cliToken: string,
  qaTryId: string,
  fetchImpl?: FetchLike,
): Promise<LlmUsageTotals | null> {
  const endpoint = `${apiBaseUrl}${LLM_USAGE_QA_RUNS_PATH}/${encodeURIComponent(qaTryId)}`;
  const body = await requestJson({
    method: 'GET',
    endpoint,
    cliToken,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return null;
  }
  const totals = (body as { totals?: unknown }).totals;
  if (typeof totals !== 'object' || totals === null || Array.isArray(totals)) {
    return null;
  }
  const fields = totals as Record<string, unknown>;
  return {
    inputTokens: readNumber(fields['inputTokens']),
    outputTokens: readNumber(fields['outputTokens']),
    cachedInputTokens: readNumber(fields['cachedInputTokens']),
    reasoningTokens: readNumber(fields['reasoningTokens']),
    costUsd: readNullableNumber(fields['costUsd']),
    calls: readNumber(fields['calls']),
    pricedCalls: readNumber(fields['pricedCalls']),
  };
}

/**
 * 모양이 어긋나면 오류가 아니라 0 이다. 이 값을 못 읽었다고 런 보고 전체를 실패로 돌리면,
 * 판정을 물으러 온 사람이 판정을 못 본다 — 비용은 다른 질문이다.
 */
function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** `costUsd` 만 다르다. 모르는 것은 0 이 아니라 `null` 이다. */
function readNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
