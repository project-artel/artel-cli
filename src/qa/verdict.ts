import type { QaLog } from '../http/qa.js';

/**
 * QA 판정. `PASSED`/`FAILED` 는 Agent 가 말한 것이고, `null` 은 **모른다** 는 뜻이다.
 *
 * 모르는 것을 실패로 접지 않는다. 소켓이 죽거나 취소된 런은 종단 요약을 싣지 못하는데,
 * 그것을 실패로 세면 "잘 죽는 설정"이 "테스트를 잘 잡아내는 설정"과 구별되지 않는다 —
 * 서버가 `verdict_known` 을 따로 집계하는 이유와 같다(`QaStatsDtos.kt`).
 */
export type QaVerdict = 'PASSED' | 'FAILED' | null;

/** 셋 다 모를 수 있다. 0 과 null 은 다르다. */
export interface QaCounts {
  total: number | null;
  passed: number | null;
  failed: number | null;
}

export interface QaStepResult {
  step: number;
  passed: boolean;
  caseId: string | null;
  isVerification: boolean;
  message: string | null;
}

/** 종단 STATUS frame 하나에서 읽어 낸 전부. */
export interface QaTerminalFrame {
  /** `COMPLETED` / `FAILED` / `CANCELLED`. 런 생명주기이지 판정이 아니다. */
  status: string;
  verdict: QaVerdict;
  steps: QaCounts;
  cases: QaCounts;
  stepResults: QaStepResult[];
}

const TERMINAL_FRAME_STATUSES = ['COMPLETED', 'FAILED', 'CANCELLED'];

export const UNKNOWN_COUNTS: QaCounts = { total: null, passed: null, failed: null };

/**
 * 서버의 `isRunTerminal`(`QaLogService.kt`)과 같은 규칙이다.
 *
 * 상태 단어만으로는 갈리지 않는다 — Agent 는 스텝 하나의 판정에도 `COMPLETED`/`FAILED` 를
 * 쓴다. 런 단위 표시는 `completedAt` 이고, 그 값은 종단 전이에서만 찍힌다. 이 규칙이
 * 서버와 어긋나면 `watch` 가 stream 이 이미 닫힌 뒤에도 계속 기다리거나, 스텝 하나를
 * 런의 끝으로 착각한다.
 */
export function isTerminalFrame(log: QaLog): boolean {
  if (log.type !== 'STATUS') {
    return false;
  }
  const payload = asRecord(log.payload);
  if (payload === null) {
    return false;
  }
  const status = payload['status'];
  const completedAt = payload['completedAt'];
  return (
    typeof status === 'string' &&
    TERMINAL_FRAME_STATUSES.includes(status) &&
    completedAt !== null &&
    completedAt !== undefined
  );
}

export function readTerminalFrame(log: QaLog): QaTerminalFrame | null {
  if (!isTerminalFrame(log)) {
    return null;
  }
  const payload = asRecord(log.payload);
  if (payload === null) {
    return null;
  }
  const summary = asRecord(payload['summary']);
  return {
    status: typeof payload['status'] === 'string' ? payload['status'] : '',
    verdict: readVerdict(payload['result']),
    steps: readCounts(summary === null ? undefined : summary['steps']),
    cases: readCounts(summary === null ? undefined : summary['cases']),
    stepResults: readStepResults(summary === null ? undefined : summary['steps']),
  };
}

/**
 * 로그 한 페이지의 **뒤에서부터** 종단 frame 을 찾는다. 서버의 stream 은 종단 frame 에서
 * 멈추므로 그 뒤로 붙는 frame 이 없고, 마지막 페이지에 없으면 이 런은 종단 frame 없이
 * 끝난 것이다 — 그때 판정은 실패가 아니라 미상이다.
 */
export function findTerminalFrame(logs: readonly QaLog[]): QaTerminalFrame | null {
  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const log = logs[index];
    if (log === undefined) {
      continue;
    }
    const frame = readTerminalFrame(log);
    if (frame !== null) {
      return frame;
    }
  }
  return null;
}

/**
 * 스텝 판정 frame 하나. 서버의 `findStepVerdicts` 와 같은 조건이다: `result` 가 없고
 * `step` 이 있는 AGENT_TO_ORCHE STATUS.
 */
export function readStepFrame(log: QaLog): QaStepResult | null {
  if (log.type !== 'STATUS' || log.direction !== 'AGENT_TO_ORCHE') {
    return null;
  }
  const payload = asRecord(log.payload);
  if (payload === null) {
    return null;
  }
  const step = payload['step'];
  if (typeof step !== 'number' || payload['result'] !== null) {
    return null;
  }
  return {
    step,
    passed: payload['status'] === 'COMPLETED',
    caseId: readId(payload['case_id']),
    isVerification: payload['is_verification'] === true,
    message: typeof payload['message'] === 'string' ? payload['message'] : null,
  };
}

/**
 * try 판정들을 런 하나의 판정으로 접는다.
 *
 * 하나라도 `FAILED` 면 런은 `FAILED` 다. 실패가 없어도 모르는 try 가 하나라도 있으면
 * 런의 판정은 미상이다 — 나머지가 전부 통과했다는 것이 시나리오 하나를 판정하지 못한
 * 사실을 덮지 못한다. try 가 하나도 없으면 미상이다.
 */
export function rollUpVerdict(verdicts: readonly QaVerdict[]): QaVerdict {
  if (verdicts.length === 0) {
    return null;
  }
  if (verdicts.includes('FAILED')) {
    return 'FAILED';
  }
  return verdicts.includes(null) ? null : 'PASSED';
}

/** 아는 값만 더한다. 아는 값이 하나도 없으면 그 칸은 null 로 남는다. */
export function sumCounts(counts: readonly QaCounts[]): QaCounts {
  return {
    total: sumKnown(counts.map((value) => value.total)),
    passed: sumKnown(counts.map((value) => value.passed)),
    failed: sumKnown(counts.map((value) => value.failed)),
  };
}

function sumKnown(values: readonly (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : known.reduce((left, right) => left + right, 0);
}

function readVerdict(value: unknown): QaVerdict {
  if (value === 'PASSED') {
    return 'PASSED';
  }
  return value === 'FAILED' ? 'FAILED' : null;
}

function readCounts(value: unknown): QaCounts {
  const record = asRecord(value);
  if (record === null) {
    return UNKNOWN_COUNTS;
  }
  return {
    total: readCount(record['total']),
    passed: readCount(record['passed']),
    failed: readCount(record['failed']),
  };
}

function readCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readStepResults(value: unknown): QaStepResult[] {
  const record = asRecord(value);
  const items = record === null ? undefined : record['items'];
  if (!Array.isArray(items)) {
    return [];
  }
  const results: QaStepResult[] = [];
  for (const item of items) {
    const step = asRecord(item);
    if (step === null || typeof step['step'] !== 'number') {
      continue;
    }
    results.push({
      step: step['step'],
      passed: step['passed'] === true,
      caseId: readId(step['case_id']),
      isVerification: step['is_verification'] === true,
      message: typeof step['message'] === 'string' ? step['message'] : null,
    });
  }
  return results;
}

/** `case_id` 는 JSON 숫자로 온다. id 는 문자열로 통일한다 — 응답의 다른 id 와 같은 모양이어야 한다. */
function readId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
