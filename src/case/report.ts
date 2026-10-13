import type { TestCase, TestCaseDetail } from '../http/testcase.js';
import type { TestCaseFolder } from '../http/testcaseFolders.js';
import type {
  TestCaseDetailPayload,
  TestCaseFolderPayload,
  TestCasePayload,
} from '../output/contract.js';

/** [TestCase] → `--json` payload. 필드는 같지만, 도메인 타입과 공개 계약을 갈라 둔다. */
export function toTestCasePayload(testCase: TestCase): TestCasePayload {
  return { ...testCase };
}

export function toTestCaseDetailPayload(testCase: TestCaseDetail): TestCaseDetailPayload {
  return { ...testCase };
}

export function toTestCaseFolderPayload(folder: TestCaseFolder): TestCaseFolderPayload {
  return { ...folder };
}
