import { CliError } from '../errors.js';
import type { TestCaseCreateRequest, TestCaseUpdateRequest } from '../http/testcase.js';

const CREATE_FIELDS = ['scene', 'step', 'precondition', 'expectedValue'] as const;
const UPDATE_FIELDS = [
  'scene',
  'step',
  'precondition',
  'expectedValue',
  'verificationStatus',
] as const;

/**
 * body 의 JSON 값 하나를 [TestCaseCreateRequest] 로 좁힌다.
 *
 * `label` 은 배열로 여럿을 만들 때 어느 항목이 틀렸는지 가리키는 자리다(`items[3]` 등) —
 * 단건일 때는 `"body"`.
 */
export function toCreateRequest(value: unknown, label: string): TestCaseCreateRequest {
  const record = asRecord(value, label, 'a test case object');
  const request: TestCaseCreateRequest = {};
  for (const field of CREATE_FIELDS) {
    const parsed = optionalString(record[field], `${label}.${field}`);
    if (parsed !== undefined) {
      request[field] = parsed;
    }
  }
  return request;
}

export function toUpdateRequest(value: unknown): TestCaseUpdateRequest {
  const record = asRecord(value, 'body', 'the fields to change');
  const request: TestCaseUpdateRequest = {};
  for (const field of UPDATE_FIELDS) {
    const parsed = optionalString(record[field], `body.${field}`);
    if (parsed !== undefined) {
      request[field] = parsed;
    }
  }
  return request;
}

function asRecord(value: unknown, label: string, wants: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CliError('case_invalid_body', `${label} must be a JSON object holding ${wants}.`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new CliError('case_invalid_body', `${field} must be a string.`);
  }
  return value;
}
