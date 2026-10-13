import type {
  CaseCreateBatchPayload,
  CaseDeletePayload,
  CaseFolderDeletePayload,
  CaseFolderListPayload,
  CaseListPayload,
  CaseMovePayload,
  TestCaseDetailPayload,
  TestCaseFolderPayload,
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
  field(sink, 'folder', payload.folderId ?? '-');
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

/**
 * folder 를 tree 로 그린다. 부모가 목록에 없는 folder 는 최상위에 놓는다. 서버가 그런 행을 줄
 * 일은 없지만, 빠뜨리고 그리면 있는 folder 가 출력에서 사라진다.
 */
export function reportCaseFolderList(
  sink: OutputSink,
  json: boolean,
  projectId: string,
  payload: CaseFolderListPayload,
): void {
  if (json) {
    writeJsonPayload(sink, payload);
    return;
  }
  sink.out(`${String(payload.items.length)} folder(s) in project ${projectId}.`);
  const ids = new Set(payload.items.map((item) => item.id));
  const children = new Map<string | null, TestCaseFolderPayload[]>();
  for (const item of payload.items) {
    const parent = item.parentId !== null && ids.has(item.parentId) ? item.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), item]);
  }
  const printBranch = (parentId: string | null, depth: number): void => {
    for (const item of children.get(parentId) ?? []) {
      sink.out(`  ${item.id.padStart(6)}  ${'  '.repeat(depth)}${item.name}${folderOrigin(item)}`);
      printBranch(item.id, depth + 1);
    }
  };
  printBranch(null, 0);
}

function folderOrigin(folder: TestCaseFolderPayload): string {
  return folder.gameBuildId === null ? '' : `  (content map of build ${folder.gameBuildId})`;
}

export function reportTestCaseFolder(
  sink: OutputSink,
  json: boolean,
  projectId: string,
  payload: TestCaseFolderPayload,
  verb: string,
): void {
  if (json) {
    writeJsonPayload(sink, payload);
    return;
  }
  sink.out(`${verb} folder ${payload.id} in project ${projectId}.`);
  field(sink, 'name', payload.name);
  field(sink, 'parent', payload.parentId ?? '- (top level)');
  field(sink, 'content map build', payload.gameBuildId ?? '-');
}

export function reportCaseFolderDeleted(
  sink: OutputSink,
  json: boolean,
  payload: CaseFolderDeletePayload,
): void {
  if (json) {
    writeJsonPayload(sink, payload);
    return;
  }
  sink.out(`Deleted folder ${payload.id} from project ${payload.projectId}.`);
  sink.out('  Its subfolders were deleted with it; the test cases inside now have no folder.');
}

export function reportCaseMove(sink: OutputSink, json: boolean, payload: CaseMovePayload): void {
  if (json) {
    writeJsonPayload(sink, payload);
    return;
  }
  const target = payload.folderId === null ? 'no folder' : `folder ${payload.folderId}`;
  sink.out(
    `Moved ${String(payload.moved)}/${String(payload.requested)} test case(s) to ${target} in project ${payload.projectId}.`,
  );
  if (payload.moved < payload.requested) {
    sink.out(
      `  ${String(payload.requested - payload.moved)} id(s) were skipped: they do not exist in this project.`,
    );
  }
}
