import { UsageError } from '../errors.js';
import type { QaStatsCell } from '../http/qa.js';
import type { QaDiffSelectorPayload, QaMetricsPayload } from '../output/contract.js';

/**
 * 셀을 고르는 축 이름. `/api/qa-stats` 가 내보내는 이름 그대로다 — 별칭을 두면 사용자가
 * `--json` 에서 본 이름과 명령줄에 쓰는 이름이 달라진다.
 */
export const SELECTOR_KEYS = ['model', 'reasoningEffort', 'promptVersion', 'agentArch'] as const;

export type SelectorKey = (typeof SELECTOR_KEYS)[number];

const EMPTY_SELECTOR: QaDiffSelectorPayload = {
  model: null,
  reasoningEffort: null,
  promptVersion: null,
  agentArch: null,
};

/**
 * `model=openai/gpt-5.6-luna,promptVersion=v15` 를 축 선택으로 읽는다.
 *
 * 적지 않은 축은 `null` 이고, 그 축의 모든 값이 함께 합쳐진다. 합쳐도 되는 이유는 서버가
 * 비율이 아니라 합계를 주기 때문이다 — 합계는 더할 수 있고 비율은 더할 수 없다.
 *
 * 축을 하나도 적지 않은 선택은 거절한다. 그것은 프로젝트 전체를 자기 자신과 비교하는
 * 것이고, 오타 하나로 그 상태에 빠지면 결과가 전부 0 이라 틀렸다는 것도 보이지 않는다.
 */
export function parseSelector(input: string, label: string): QaDiffSelectorPayload {
  const selector: QaDiffSelectorPayload = { ...EMPTY_SELECTOR };
  const seen = new Set<SelectorKey>();

  for (const part of input.split(',')) {
    const pair = part.trim();
    if (pair.length === 0) {
      continue;
    }
    const separator = pair.indexOf('=');
    if (separator <= 0) {
      throw new UsageError(
        `${label} takes "key=value" pairs separated by commas, but got "${pair}". Valid keys: ${SELECTOR_KEYS.join(', ')}.`,
      );
    }
    const key = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (!isSelectorKey(key)) {
      throw new UsageError(
        `${label} does not know the axis "${key}". Valid keys: ${SELECTOR_KEYS.join(', ')}.`,
      );
    }
    if (value.length === 0) {
      throw new UsageError(`${label} got an empty value for "${key}".`);
    }
    if (seen.has(key)) {
      throw new UsageError(`${label} names "${key}" twice.`);
    }
    seen.add(key);
    selector[key] = value;
  }

  if (seen.size === 0) {
    throw new UsageError(
      `${label} names no axis. Give at least one of ${SELECTOR_KEYS.join(', ')}, for example model=openai/gpt-5.6-luna.`,
    );
  }
  return selector;
}

/**
 * 선택에 걸리는 셀들.
 *
 * 축 값이 `null` 인 셀은 그 축이 **미상**인 런들이다. 선택이 그 축을 짚었으면 미상 셀은
 * 걸리지 않는다 — 무엇으로 돌았는지 모르는 런을 특정 설정의 성적으로 세면 그 설정이
 * 하지 않은 일을 했다고 말하는 것이 된다.
 */
export function matchCells(
  cells: readonly QaStatsCell[],
  selector: QaDiffSelectorPayload,
): QaStatsCell[] {
  return cells.filter((cell) =>
    SELECTOR_KEYS.every((key) => selector[key] === null || cell[key] === selector[key]),
  );
}

/** 여러 셀을 한 줄로 합친다. 합계는 더하고, 평균 하나는 `completed` 로 가중한다. */
export function sumMetrics(cells: readonly QaStatsCell[]): QaMetricsPayload {
  const sum = (pick: (cell: QaStatsCell) => number): number =>
    cells.reduce((total, cell) => total + pick(cell), 0);

  return {
    runs: sum((cell) => cell.runs),
    completed: sum((cell) => cell.completed),
    failed: sum((cell) => cell.failed),
    cancelled: sum((cell) => cell.cancelled),
    active: sum((cell) => cell.active),
    inputTokens: sum((cell) => cell.inputTokens),
    outputTokens: sum((cell) => cell.outputTokens),
    cachedInputTokens: sum((cell) => cell.cachedInputTokens),
    reasoningTokens: sum((cell) => cell.reasoningTokens),
    costUsd: sumCost(cells),
    llmCalls: sum((cell) => cell.llmCalls),
    avgCompletedDurationMs: weightedAverageDuration(cells),
    verdictKnown: sum((cell) => cell.verdictKnown),
    stepsTotal: sum((cell) => cell.stepsTotal),
    stepsPassed: sum((cell) => cell.stepsPassed),
    casesTotal: sum((cell) => cell.casesTotal),
    casesPassed: sum((cell) => cell.casesPassed),
    scoredRuns: sum((cell) => cell.scoredRuns),
    correctPass: sum((cell) => cell.correctPass),
    falseAlarm: sum((cell) => cell.falseAlarm),
    miss: sum((cell) => cell.miss),
    correctFail: sum((cell) => cell.correctFail),
    unreported: sum((cell) => cell.unreported),
  };
}

/** `target - base`. 어느 한쪽이라도 모르면 그 칸은 모른다. */
export function differenceOf(base: QaMetricsPayload, target: QaMetricsPayload): QaMetricsPayload {
  return {
    runs: target.runs - base.runs,
    completed: target.completed - base.completed,
    failed: target.failed - base.failed,
    cancelled: target.cancelled - base.cancelled,
    active: target.active - base.active,
    inputTokens: target.inputTokens - base.inputTokens,
    outputTokens: target.outputTokens - base.outputTokens,
    cachedInputTokens: target.cachedInputTokens - base.cachedInputTokens,
    reasoningTokens: target.reasoningTokens - base.reasoningTokens,
    costUsd: subtractKnown(target.costUsd, base.costUsd, 6),
    llmCalls: target.llmCalls - base.llmCalls,
    avgCompletedDurationMs: subtractKnown(
      target.avgCompletedDurationMs,
      base.avgCompletedDurationMs,
      3,
    ),
    verdictKnown: target.verdictKnown - base.verdictKnown,
    stepsTotal: target.stepsTotal - base.stepsTotal,
    stepsPassed: target.stepsPassed - base.stepsPassed,
    casesTotal: target.casesTotal - base.casesTotal,
    casesPassed: target.casesPassed - base.casesPassed,
    scoredRuns: target.scoredRuns - base.scoredRuns,
    correctPass: target.correctPass - base.correctPass,
    falseAlarm: target.falseAlarm - base.falseAlarm,
    miss: target.miss - base.miss,
    correctFail: target.correctFail - base.correctFail,
    unreported: target.unreported - base.unreported,
  };
}

/** 분모가 0 이면 비율은 없다. 0/0 을 100% 로도 0% 로도 만들지 않는다. */
export function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

export function describeSelector(selector: QaDiffSelectorPayload): string {
  const named = SELECTOR_KEYS.filter((key) => selector[key] !== null).map(
    (key) => `${key}=${String(selector[key])}`,
  );
  return named.length === 0 ? 'any' : named.join(', ');
}

function isSelectorKey(value: string): value is SelectorKey {
  return (SELECTOR_KEYS as readonly string[]).includes(value);
}

/**
 * 단가를 아는 호출이 하나도 없는 셀의 `costUsd` 는 `null` 이고, 그것은 0 이 아니라 미상이다.
 * 그런 셀이 하나라도 섞이면 합계도 미상이다 — 아는 것만 더해 내놓으면 실제보다 싸 보이고,
 * 그 차이는 정확히 모르는 만큼이라 아무도 알아채지 못한다.
 */
function sumCost(cells: readonly QaStatsCell[]): number | null {
  if (cells.length === 0 || cells.some((cell) => cell.costUsd === null)) {
    return null;
  }
  return round(
    cells.reduce((total, cell) => total + (cell.costUsd ?? 0), 0),
    6,
  );
}

/**
 * 완주 런의 평균 소요를 셀 여럿에 걸쳐 낸다. 평균끼리 그냥 더하거나 다시 평균 내면 런이
 * 하나인 셀과 백 개인 셀이 같은 무게를 갖는다. 각 평균이 얹힌 런 수가 `completed` 이므로
 * 그것을 가중치로 쓴다.
 */
function weightedAverageDuration(cells: readonly QaStatsCell[]): number | null {
  let weighted = 0;
  let weight = 0;
  for (const cell of cells) {
    if (cell.avgCompletedDurationMs === null) {
      continue;
    }
    weighted += cell.avgCompletedDurationMs * cell.completed;
    weight += cell.completed;
  }
  return weight === 0 ? null : round(weighted / weight, 3);
}

function subtractKnown(target: number | null, base: number | null, digits: number): number | null {
  return target === null || base === null ? null : round(target - base, digits);
}

/** 부동소수 잔여물을 자른다. `13424.032000000001 - 13424.032` 는 0 이어야 한다. */
function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
