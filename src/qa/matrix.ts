/**
 * `qa matrix` 의 조합 전개와 슬롯 배정. HTTP 도 프로세스도 건드리지 않는 순수 계산이라,
 * "같은 명령이 같은 조합을 같은 슬롯에 보낸다" 를 이 파일만 보고 확인할 수 있다.
 */

/**
 * 축 하나의 값. `null` 은 그 축의 flag 를 주지 않았다는 뜻이고, 서버 body 에서 키가 빠진다 —
 * 서버가 자기 기본값을 쓴다. 빈 문자열과는 다르다: 빈 문자열은 값으로 읽혀 400 이 된다.
 */
export type AxisValue = string | null;

/**
 * 축 다섯. 전개 순서가 이 선언 순서이고, 그것이 `--help` 와 README 가 적는 순서다.
 *
 * 순서를 고정하는 것이 요점이다 — 같은 명령을 두 번 돌리면 같은 조합이 같은 번호를 받고,
 * 그래야 [assignToSlots] 의 배정도 두 번 다 같다.
 */
export interface MatrixAxes {
  testRunIds: readonly string[];
  models: readonly AxisValue[];
  promptVersions: readonly AxisValue[];
  reasoningEfforts: readonly AxisValue[];
  contentMapModes: readonly AxisValue[];
  knowledgeModes: readonly AxisValue[];
}

export interface MatrixCombination {
  /** 전개 순서. 0부터. 슬롯 배정과 결과 정렬이 모두 이 번호를 쓴다. */
  index: number;
  testRunId: string;
  model: AxisValue;
  promptVersion: AxisValue;
  reasoningEffort: AxisValue;
  contentMapMode: AxisValue;
  knowledgeMode: AxisValue;
}

/**
 * 축 목록의 데카르트 곱. `--test-run` 이 가장 바깥이고 `--knowledge-mode` 가 가장 안쪽이라,
 * 명령줄에 적은 flag 순서대로 자리가 정해진다.
 *
 * 순서를 고정하는 것이 요점이다. 같은 명령을 두 번 돌리면 같은 조합이 같은 번호를 받고,
 * 그래야 [assignToSlots] 의 배정도 두 번 다 같다.
 */
export function expandCombinations(axes: MatrixAxes): readonly MatrixCombination[] {
  const combinations: MatrixCombination[] = [];
  for (const testRunId of axes.testRunIds) {
    for (const model of axes.models) {
      for (const promptVersion of axes.promptVersions) {
        for (const reasoningEffort of axes.reasoningEfforts) {
          for (const contentMapMode of axes.contentMapModes) {
            for (const knowledgeMode of axes.knowledgeModes) {
              combinations.push({
                index: combinations.length,
                testRunId,
                model,
                promptVersion,
                reasoningEffort,
                contentMapMode,
                knowledgeMode,
              });
            }
          }
        }
      }
    }
  }
  return combinations;
}

/**
 * 조합을 슬롯에 나눈다. 슬롯 하나가 받은 목록은 그 슬롯이 **차례로** 돌 작업 큐다.
 *
 * 먼저 빈 슬롯이 다음 조합을 집어 가는 방식(work stealing)을 쓰지 않는다. 그쪽이 처리량은
 * 낫지만 어느 조합이 어느 슬롯에 가는지가 그때그때의 실행 시간에 달리고, 그러면 같은 명령을
 * 두 번 돌린 결과를 나란히 놓을 수 없다. 슬롯마다 빌드가 다르므로 어느 슬롯에서 돌았는지는
 * 측정의 일부다 — 재현이 처리량보다 앞선다.
 */
export function assignToSlots(
  combinations: readonly MatrixCombination[],
  slotCount: number,
): readonly (readonly MatrixCombination[])[] {
  const slots: MatrixCombination[][] = Array.from({ length: slotCount }, () => []);
  for (const combination of combinations) {
    slots[combination.index % slotCount]?.push(combination);
  }
  return slots;
}

/** 조합 하나를 사람이 읽을 한 줄로. arm 이름을 짓지 않고 축 값 그대로 적는다. */
export function describeCombination(combination: MatrixCombination): string {
  return [
    `testRun=${combination.testRunId}`,
    `model=${combination.model ?? 'server default'}`,
    `prompt=${combination.promptVersion ?? 'server default'}`,
    `reasoning=${combination.reasoningEffort ?? 'server default'}`,
    `contentMap=${combination.contentMapMode ?? 'server default'}`,
    `knowledge=${combination.knowledgeMode ?? 'server default'}`,
  ].join(' ');
}
