import type { LlmUsageTotals } from '../http/llmUsage.js';
import type { QaUsagePayload } from '../output/contract.js';

/**
 * try 들의 지출을 런 하나의 값으로 합친다.
 *
 * 합만 더한다. `qa diff` 가 셀을 합칠 때 지키는 규율과 같다 — 합은 더할 수 있고 비율은 더할 수
 * 없다. 여기서 더하는 것은 전부 합이고, 평균이나 비율은 이 payload 에 없다.
 *
 * `costUsd` 는 값이 있는 try 들만 더한다. 하나도 없으면 `null` 이다 — 0 으로 만들면 "단가를
 * 모른다" 와 "공짜였다" 가 같은 값이 되고, 그 둘을 섞은 표로 arm 비용을 비교하면 결론이 틀린다.
 * 얼마나 많은 호출에 그 금액이 얹혔는지는 `pricedCalls` 와 `calls` 가 말한다.
 */
export function sumUsage(parts: readonly (LlmUsageTotals | null)[]): QaUsagePayload | null {
  const known = parts.filter((part): part is LlmUsageTotals => part !== null);
  if (known.length === 0) {
    return null;
  }

  const priced = known.filter((part) => part.costUsd !== null);

  return {
    inputTokens: sum(known.map((part) => part.inputTokens)),
    outputTokens: sum(known.map((part) => part.outputTokens)),
    cachedInputTokens: sum(known.map((part) => part.cachedInputTokens)),
    reasoningTokens: sum(known.map((part) => part.reasoningTokens)),
    costUsd: priced.length === 0 ? null : sum(priced.map((part) => part.costUsd ?? 0)),
    calls: sum(known.map((part) => part.calls)),
    pricedCalls: sum(known.map((part) => part.pricedCalls)),
  };
}

/** try 하나의 값도 같은 payload 모양으로 낸다. 런과 try 를 두 모양으로 적지 않는다. */
export function toUsagePayload(totals: LlmUsageTotals | null): QaUsagePayload | null {
  return totals === null ? null : { ...totals };
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
