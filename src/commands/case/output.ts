import type {
  CaseCreateBatchPayload,
  CaseDeletePayload,
  CaseListPayload,
  TestCaseDetailPayload,
  TestCasePayload,
} from '../../output/contract.js';
import { writeJsonPayload, type OutputSink } from '../../output/envelope.js';

const LABEL_WIDTH = 20;
const LIST_LINE_LIMIT = 72;

function field(sink: OutputSink, label: string, value: string): void {
  sink.out(`  ${label.padEnd(LABEL_WIDTH)}${value}`);
}

/** 여러 줄에 걸친 값을 목록 한 줄에 넣을 수 있게 접는다. 표를 만들지 않는다 — 원문은 `case show` 가 낸다. */
function singleLine(value: string): string {
  const flattened = value.replace(/\s+/g, ' ').trim();
  return flattened.length > LIST_LINE_LIMIT
    ? `${flattened.slice(0, LIST_LINE_LIMIT - 1)}…`
    : flattened;
}

export function reportCaseList(
  sink: OutputSink,
  json: boolean,
  projectId: string,
  payload: CaseListPayload,
): void {
  if (json) {
    writeJsonPayload(sink, payload);
    return;
  }
  sink.out(`${String(payload.items.length)} test case(s) in project ${projectId}.`);
  for (const item of payload.items) {
    sink.out(
      `  ${item.id.padStart(6)}  ${item.verificationStatus.padEnd(10)}  ${singleLine(item.scene)} — ${singleLine(item.step)}`,
    );
  }
}

export function reportTestCase(
  sink: OutputSink,
  json: boolean,
  payload: TestCasePayload,
  verb: string,
): void {
  if (json) {
    writeJsonPayload(sink, payload);
    return;
  }
  sink.out(`${verb} test case ${payload.id} in project ${payload.projectId}.`);
  printTestCaseFields(sink, payload);
}

export function reportTestCaseDetail(
  sink: OutputSink,
  json: boolean,
  payload: TestCaseDetailPayload,
): void {
  if (json) {
    writeJsonPayload(sink, payload);
    return;
  }
  sink.out(`Test case ${payload.id} in project ${payload.projectId}.`);
  printTestCaseFields(sink, payload);
  field(
    sink,
    'evidence gaps',
    payload.evidenceGaps.length === 0 ? 'none' : payload.evidenceGaps.join(', '),
  );
}

function printTestCaseFields(sink: OutputSink, payload: TestCasePayload): void {
  field(sink, 'scene', payload.scene);
  field(sink, 'step', payload.step);
  field(sink, 'precondition', payload.precondition ?? '-');
  field(sink, 'expected value', payload.expectedValue);
  field(sink, 'status', payload.status ?? '-');
  field(sink, 'verification status', payload.verificationStatus);
  field(sink, 'last verified build', payload.lastVerifiedBuildId ?? '-');
  field(sink, 'created at', payload.createdAt);
}

/**
 * `case create` 가 JSON body 로 배열을 받았을 때. 일부만 만들어졌어도 exit code 는 이미
 * 명령이 정했으니, 여기서는 무엇이 되고 무엇이 안 됐는지만 있는 그대로 나열한다.
 */
export function reportCaseCreateBatch(
  sink: OutputSink,
  json: boolean,
  payload: CaseCreateBatchPayload,
): void {
  if (json) {
    writeJsonPayload(sink, payload);
    return;
  }
  sink.out(
    `Created ${String(payload.created)}/${String(payload.requested)} test case(s) in project ${payload.projectId}${
      payload.failed === 0 ? '.' : `; ${String(payload.failed)} failed.`
    }`,
  );
  for (const result of payload.results) {
    if (result.created !== null) {
      sink.out(
        `  [${String(result.index)}] created  ${result.created.id}  ${singleLine(result.created.scene)} — ${singleLine(result.created.step)}`,
      );
    } else {
      sink.out(
        `  [${String(result.index)}] FAILED  ${result.error?.code}  ${result.error?.message}`,
      );
    }
  }
}

export function reportCaseDeleted(
  sink: OutputSink,
  json: boolean,
  payload: CaseDeletePayload,
): void {
  if (json) {
    writeJsonPayload(sink, payload);
    return;
  }
  sink.out(`Deleted test case ${payload.id} from project ${payload.projectId}.`);
}
