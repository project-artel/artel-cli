import { CliError } from '../errors.js';
import type { TestCaseCreateRequest, TestCaseUpdateRequest } from '../http/testcase.js';

const CREATE_FIELDS = ['scene', 'step', 'precondition', 'expectedValue', 'folderId'] as const;
/** 서버(`TestCaseService.requireField`)가 비어 있지 않은 문자열을 요구하는 필드. */
const REQUIRED_CREATE_FIELDS = ['scene', 'step', 'expectedValue'] as const;

/** 필수 필드 오류 메시지에 붙이는 예시 한 줄. */
export const CASE_CREATE_EXAMPLE =
  '{"scene": "Title Screen", "step": "Tap New Game", "expectedValue": "The game starts"}';

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

/**
 * 필수 필드 중 비었거나 없는 것의 이름. 서버는 첫 번째 빠진 필드에서 "scene is required" 하나만
 * 돌려주므로, 파일을 서버에 보내기 전에 CLI 가 빠진 것 전부를 알려 준다.
 */
export function missingCreateFields(request: TestCaseCreateRequest): string[] {
  return REQUIRED_CREATE_FIELDS.filter((field) => (request[field] ?? '').trim().length === 0);
}

/** 항목 하나의 필수 필드가 빠졌으면 `case_invalid_body` 로 던진다. 예시 한 줄을 함께 싣는다. */
export function requireCreateFields(request: TestCaseCreateRequest, label: string): void {
  const missing = missingCreateFields(request);
  if (missing.length > 0) {
    throw new CliError('case_invalid_body', describeMissing(label, missing));
  }
}

export function describeMissing(label: string, missing: string[]): string {
  return `${label} is missing required field(s): ${missing.join(', ')}. Every test case needs scene, step and expectedValue, for example ${CASE_CREATE_EXAMPLE}.`;
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
