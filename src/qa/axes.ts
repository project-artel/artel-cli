import { UsageError } from '../errors.js';

/**
 * `contentMapMode` 와 `knowledgeMode` 가 받는 값. 서버의 `ContentMapMode.WIRE_NAMES` 와
 * `KnowledgeMode.WIRE_NAMES` 를 그대로 옮긴 것이다.
 *
 * ## 왜 CLI 도 검증하나
 *
 * 목록을 두 군데 적으면 언젠가 어긋난다. 서버가 모드를 하나 더하면 이 파일이 그것을 막는
 * 쪽이 되고, 그때 고칠 곳이 늘어난다. 그것을 알면서도 여기서 검증하는 이유는 `qa matrix` 다:
 * matrix 는 축 목록의 곱을 슬롯에 나눠 한 조합씩 차례로 돌리므로, 네 번째 조합의 오타는
 * 앞의 세 조합이 몇 분씩 돈 **뒤에야** 400 으로 드러난다. 그 세 런은 실제 게임을 띄워 태운
 * 시간이고 되돌릴 수 없다. 왕복 한 번을 아끼는 것이 아니라 잘못 태운 측정을 막는 것이다.
 *
 * 어긋났을 때의 증상도 한쪽이 낫다. CLI 목록이 낡으면 서버가 받는 값을 CLI 가 거절하고,
 * 사용자는 그것을 곧바로 본다. 반대로 검증을 안 두면 오타가 400 으로 돌아오는데, 그것은
 * 조합 하나가 실패로 기록된 뒤다.
 *
 * 새 모드가 생기면 이 배열에 값을 더하는 것이 전부다.
 */
export const CONTENT_MAP_MODES: readonly string[] = ['on', 'frozen', 'off'];

export const KNOWLEDGE_MODES: readonly string[] = ['learning', 'frozen', 'off'];

/**
 * 축 값 하나를 검증해 그대로 돌려준다. 빈 문자열도 여기서 걸린다 — 서버는 빈 문자열을 값으로
 * 읽으므로 body 에 실어서는 안 된다.
 */
export function requireAxisValue(
  value: string,
  flagLabel: string,
  allowed: readonly string[],
): string {
  if (!allowed.includes(value)) {
    throw new UsageError(`${flagLabel} takes one of ${allowed.join(', ')}, not "${value}".`);
  }
  return value;
}

/**
 * `--test-run 1,2` 처럼 콤마로 나열한 축 목록을 읽는다. 항목 순서는 준 그대로 지킨다 —
 * `qa matrix` 의 조합 전개 순서가 이 순서에서 나오므로, 정렬하거나 재배치하면 같은 명령이
 * 다른 순서를 낸다.
 *
 * 같은 값을 두 번 적은 것은 오타로 보고 거절한다. 벤치마크에서 조합 하나가 두 번 도는 것은
 * 그 셀의 가중치가 조용히 두 배가 되는 일이고, 결과를 보고 알아채기 어렵다.
 */
export function parseAxisList(raw: string, flagLabel: string): readonly string[] {
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (values.length === 0) {
    throw new UsageError(`${flagLabel} needs at least one value.`);
  }

  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new UsageError(`${flagLabel} lists "${value}" twice.`);
    }
    seen.add(value);
  }
  return values;
}

/** 축 목록을 읽고 각 항목을 검증한다. `parseAxisList` 와 `requireAxisValue` 의 짝. */
export function parseAxisValues(
  raw: string,
  flagLabel: string,
  allowed: readonly string[],
): readonly string[] {
  return parseAxisList(raw, flagLabel).map((value) => requireAxisValue(value, flagLabel, allowed));
}

/** `qa_run.label` 이 255자를 넘으면 서버가 400 이다. */
const MAX_LABEL_LENGTH = 255;

/**
 * `--label` 을 읽는다. 앞뒤 공백만 지운다.
 *
 * 공백뿐인 값은 거절한다. 서버는 그것을 `null` 로 읽지만, 그러면 사용자가 이름을 지었다고
 * 믿은 런에 이름이 없는 채로 측정이 끝난다.
 */
export function parseLabel(raw: string): string {
  const label = raw.trim();
  if (label.length === 0) {
    throw new UsageError('--label needs a name; it cannot be blank.');
  }
  if (label.length > MAX_LABEL_LENGTH) {
    throw new UsageError(
      `--label must be at most ${String(MAX_LABEL_LENGTH)} characters, not ${String(label.length)}.`,
    );
  }
  return label;
}
