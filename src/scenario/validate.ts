import { CliError } from '../errors.js';
import type { ExpectedLabelInput, ScenarioStepInput } from '../http/scenario.js';

/**
 * `steps`/`expected-labels` 입력을 서버로 보내기 전에 여기서 거절한다.
 *
 * 2026-09-03 에 `psql` 로 시나리오 하나를 손으로 끼워 넣었을 때, `steps` 가 `jsonb` 라
 * 모양이 맞는지 아무것도 검사하지 않았다. Agent 계약(`QaStep`)이 아는 필드는 넷뿐이라
 * 오타 하나(`caseId` 를 `case_id` 대신 쓰는 것 같은)가 조용히 버려지고, 그 스텝은
 * 케이스 없는 스텝으로 실행된다. 여기서 필드 이름까지 검사하는 이유가 그것이다.
 */

const STEP_FIELDS = ['action', 'case_id', 'hint', 'input'] as const;
const LABEL_FIELDS = ['step', 'expected_passed'] as const;

export function parseScenarioSteps(text: string): ScenarioStepInput[] {
  const parsed = parseJson(text, 'steps', 'scenario_invalid_steps');
  if (!Array.isArray(parsed)) {
    throw new CliError(
      'scenario_invalid_steps',
      `steps must be a JSON array, not ${describeType(parsed)}.`,
    );
  }
  return parsed.map((raw, index) => parseStep(raw, index));
}

export function parseExpectedLabelEntries(text: string): ExpectedLabelInput[] {
  const parsed = parseJson(text, 'expected labels', 'scenario_invalid_labels');
  if (!Array.isArray(parsed)) {
    throw new CliError(
      'scenario_invalid_labels',
      `expected labels must be a JSON array, not ${describeType(parsed)}.`,
    );
  }
  return parsed.map((raw, index) => parseLabelEntry(raw, index));
}

function parseJson(
  text: string,
  what: string,
  code: 'scenario_invalid_steps' | 'scenario_invalid_labels',
): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CliError(
      code,
      `${what} must be valid JSON: ${error instanceof Error ? error.message : 'could not parse it'}.`,
    );
  }
}

function parseStep(raw: unknown, index: number): ScenarioStepInput {
  const field = `steps[${String(index)}]`;
  const record = asPlainObject(raw, field, 'scenario_invalid_steps');
  rejectUnknownFields(record, STEP_FIELDS, field, 'scenario_invalid_steps');

  const action = record['action'];
  if (typeof action !== 'string' || action.length === 0) {
    throw new CliError(
      'scenario_invalid_steps',
      `${field}.action must be a non-empty string, naming the action the agent takes.`,
    );
  }

  return {
    action,
    case_id: parseNullablePositiveInt(
      record['case_id'],
      `${field}.case_id`,
      'scenario_invalid_steps',
    ),
    hint: parseNullableStringField(record['hint'], `${field}.hint`, 'scenario_invalid_steps'),
    input: parseNullableStringField(record['input'], `${field}.input`, 'scenario_invalid_steps'),
  };
}

function parseLabelEntry(raw: unknown, index: number): ExpectedLabelInput {
  const field = `[${String(index)}]`;
  const record = asPlainObject(raw, field, 'scenario_invalid_labels');
  rejectUnknownFields(record, LABEL_FIELDS, field, 'scenario_invalid_labels');

  if (!('step' in record)) {
    throw new CliError('scenario_invalid_labels', `${field} is missing "step".`);
  }
  const step = record['step'];
  if (typeof step !== 'number' || !Number.isInteger(step) || step < 1) {
    throw new CliError(
      'scenario_invalid_labels',
      `${field}.step must be a positive whole number (steps are numbered from 1).`,
    );
  }

  if (!('expected_passed' in record)) {
    throw new CliError('scenario_invalid_labels', `${field} is missing "expected_passed".`);
  }
  const expectedPassed = record['expected_passed'];
  if (expectedPassed !== null && typeof expectedPassed !== 'boolean') {
    throw new CliError(
      'scenario_invalid_labels',
      `${field}.expected_passed must be true, false, or null (null clears the label), not ${describeType(expectedPassed)}.`,
    );
  }

  return { step, expected_passed: expectedPassed };
}

function asPlainObject(
  value: unknown,
  field: string,
  code: 'scenario_invalid_steps' | 'scenario_invalid_labels',
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CliError(code, `${field} must be a JSON object, not ${describeType(value)}.`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
  code: 'scenario_invalid_steps' | 'scenario_invalid_labels',
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new CliError(
        code,
        `${field} has an unknown field "${key}". Allowed fields are ${allowed.join(', ')}.`,
      );
    }
  }
}

function parseNullablePositiveInt(
  value: unknown,
  field: string,
  code: 'scenario_invalid_steps' | 'scenario_invalid_labels',
): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new CliError(
      code,
      `${field} must be a positive whole number or null, not ${describeType(value)}.`,
    );
  }
  return value;
}

function parseNullableStringField(
  value: unknown,
  field: string,
  code: 'scenario_invalid_steps' | 'scenario_invalid_labels',
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new CliError(code, `${field} must be a string or null, not ${describeType(value)}.`);
  }
  return value;
}

function describeType(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'an array';
  }
  return typeof value;
}
