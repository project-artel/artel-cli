import fs from 'node:fs/promises';

import { CliError } from '../errors.js';

/**
 * `--arch` 는 Agent 의 구조 knob 묶음이고, 서버는 그것을 열어 보지 않고 그대로 Agent 에
 * 넘긴다(`CreateQaRunRequest.arch`). CLI 도 스키마를 알지 못하므로 JSON object 인지만 본다 —
 * 여기서 키를 검사하면 Agent 가 knob 을 하나 늘릴 때마다 CLI 가 그것을 막는다. 잘못된 knob
 * 은 Agent 가 422 로 거절하고, 그것은 실패한 런으로 보인다.
 */
export async function readArch(raw: string | undefined): Promise<unknown> {
  if (raw === undefined) {
    return undefined;
  }
  let text = raw;
  if (raw.startsWith('@')) {
    const path = raw.slice(1);
    try {
      text = await fs.readFile(path, 'utf8');
    } catch (error) {
      throw new CliError(
        'qa_invalid_arch',
        `Could not read --arch from ${path}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CliError(
      'qa_invalid_arch',
      '--arch takes a JSON object, or "@path" naming a file that holds one.',
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CliError(
      'qa_invalid_arch',
      '--arch must be a JSON object, not an array or a scalar.',
    );
  }
  return parsed;
}
