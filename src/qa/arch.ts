import fs from 'node:fs/promises';

import { CliError } from '../errors.js';
import type { ArchAxisValue } from './matrix.js';

/**
 * `--arch` 는 Agent 의 구조 knob 묶음이고, 서버는 그것을 열어 보지 않고 그대로 Agent 에
 * 넘긴다(`CreateQaRunRequest.arch`). CLI 도 스키마를 알지 못하므로 JSON object 인지만 본다 —
 * 여기서 키를 검사하면 Agent 가 knob 을 하나 늘릴 때마다 CLI 가 그것을 막는다. 잘못된 knob
 * 은 Agent 가 422 로 거절하고, 그것은 실패한 런으로 보인다.
 */
export async function readArch(raw: string): Promise<Record<string, unknown>>;
export async function readArch(
  raw: string | undefined,
): Promise<Record<string, unknown> | undefined>;
export async function readArch(
  raw: string | undefined,
): Promise<Record<string, unknown> | undefined> {
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
  return parsed as Record<string, unknown>;
}

/**
 * `qa matrix` 의 `--arch` 를 축 하나로 읽는다. 되풀이해 적은 값마다 [readArch] 를 그대로
 * 쓴다 — 파일 읽기와 JSON object 검증은 한 곳에만 있어야 두 검증이 어긋나지 않는다.
 *
 * 안 주면 `[null]` 을 돌려준다. 다른 축과 같은 규칙이다 — 한 칸짜리 축이 되어 조합 수가
 * 오늘과 같고, body 에는 `arch` 키가 실리지 않는다.
 *
 * `--arch` 를 정확히 한 번만 줘도 label 을 요구한다. 그것이 진짜 축이 아니라는 것은 맞지만,
 * 조건을 나누면 "언제부터 label 이 필요한가" 라는 질문이 하나 늘고 규칙이 하나 더 필요해진다.
 * 늘 요구하는 쪽이 더 단순하고, `describeCombination` 이 arm 이름을 짓지 않는다는 원칙과도
 * 어긋나지 않는다.
 */
export async function readArchAxis(specs: readonly string[]): Promise<readonly ArchAxisValue[]> {
  if (specs.length === 0) {
    return [null];
  }

  const values: Exclude<ArchAxisValue, null>[] = [];
  // 원문 문자열이 아니라 파싱한 JSON 을 키 정렬해 비교한다. 같은 object 를 `@a.json` 과
  // 인라인으로 한 번씩 준 경우가 이 검사가 잡으려는 오타이고, 원문 비교로는 그것을 놓친다.
  const specByCanonical = new Map<string, DuplicateOccurrence>();
  // label 도 따로 본다. 두 arch object 가 다르면서 label 이 같으면 위 검사를 통과하는데,
  // 그 뒤로는 label 이 곧 조합의 정체다 — `keyOfCombination` 도 `describeCombination` 도
  // label 만 읽는다. 그래서 두 조합이 `--out` 에 같은 열쇠로 적히고, `--resume` 이 뒤엣것을
  // "이미 돌았다" 며 통째로 건너뛴다. 파일 하나를 복사해 knob 만 고치고 label 을 그대로 둔
  // 것이 가장 흔한 실수이고, 그것이 정확히 이 경우다.
  const specByLabel = new Map<string, DuplicateOccurrence>();
  for (const [index, spec] of specs.entries()) {
    const position = index + 1;
    const parsed = await readArch(spec);
    const label = requireArchLabel(parsed, spec, position);
    const canonical = canonicalizeArch(parsed);

    const sameStructure = specByCanonical.get(canonical);
    if (sameStructure !== undefined) {
      throw new CliError(
        'qa_duplicate_arch',
        `--arch lists the same structure twice — once as ${describeArchSpec(sameStructure)} and once as ${describeArchSpec({ spec, position })}, both labeled "${label}". --repeat runs a combination more than once already, so a repeated --arch is always a mistake.`,
      );
    }
    const sameLabel = specByLabel.get(label);
    if (sameLabel !== undefined) {
      throw new CliError(
        'qa_duplicate_arch',
        `--arch gives two different structures the same label "${label}" — ${describeArchSpec(sameLabel)} and ${describeArchSpec({ spec, position })}. The label is what names the arm in the results and in --out, so two arms sharing one would be recorded as a single combination. Give each its own label.`,
      );
    }

    specByCanonical.set(canonical, { spec, position });
    specByLabel.set(label, { spec, position });
    values.push({ label, value: parsed });
  }
  return values;
}

/** 중복을 가리킬 때 쓰는, `--arch` 목록에서의 위치(1부터)와 그 spec 원문. */
interface DuplicateOccurrence {
  spec: string;
  position: number;
}

/**
 * arch 축 값의 label 을 읽는다. `describeCombination` 이 arm 이름을 짓지 않고 축 값 그대로
 * 적으므로, arch 축에서 그 축 값은 이 label 뿐이다 — 파일 이름으로 대신하면 파일을 옮기는
 * 것만으로 조합의 정체가 바뀐다.
 */
function requireArchLabel(
  parsed: Record<string, unknown>,
  spec: string,
  position: number,
): string {
  const label = parsed.label;
  if (typeof label !== 'string' || label.trim().length === 0) {
    throw new CliError(
      'qa_invalid_arch',
      `--arch used as an axis needs a "label" field naming the arm; ${describeArchSpec({ spec, position })} has none.`,
    );
  }
  return label;
}

/**
 * 오류 메시지에서 값을 가리키는 말. 인라인 JSON 은 길 수 있어 경로만큼 짧게 못 줄인다.
 *
 * 인라인 값은 원문을 못 보여 주니 `--arch` 목록에서 몇 번째인지(1부터)를 대신 적는다. 안 그러면
 * 인라인끼리 부딪힌 경우 "once as an inline --arch value and once as an inline --arch value"
 * 처럼 어느 쪽이 어느 쪽인지 못 가리키는 문장이 된다.
 */
function describeArchSpec({ spec, position }: DuplicateOccurrence): string {
  return spec.startsWith('@') ? spec : `an inline --arch value (#${String(position)})`;
}

/** 키를 재귀적으로 정렬한 JSON 문자열. 배열의 순서는 그대로 둔다 — 값이지 이름이 아니다. */
function canonicalizeArch(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortKeys(record[key]);
    }
    return sorted;
  }
  return value;
}
