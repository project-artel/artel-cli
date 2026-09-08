# 2026-09-08 — qa matrix 가 --repeat 으로 같은 조합을 여러 번 돌린다

- Date: 2026-09-08
- Jira: ARTEL-856
- Status: Planned
- Based on: ARTEL-855 의 branch

## Goal

`qa matrix --repeat n` 이 각 조합을 `n` 번 돌린다. 기본값 1 이면 지금 동작 그대로다.

## Context

QA agent 의 런은 결정적이지 않다. 조합당 한 번씩 돌린 표로 두 arm 을 비교하면, 본 차이가 arm
때문인지 그날의 운인지 구분할 수 없다.

## Non-goals

- 신뢰구간이나 유의성 계산.
- 반복 사이에 자동으로 설정을 흔드는 것.

## Decisions

### 반복은 축이 아니라 가장 안쪽 되풀이다

축으로 두면 `--repeat 3` 이 축 목록의 순서에 끼어들어, 반복을 켜는 것만으로 조합 번호와 슬롯
배정이 통째로 달라진다. 가장 안쪽에 두면 `--repeat 1` 일 때의 번호가 그대로 유지되고, 같은
조합의 반복들이 슬롯에 흩어져 한 슬롯 빌드의 성질이 한 조합에만 몰리지 않는다.

### `index` 와 `combination` 과 `repeat` 을 따로 싣는다

`index` 는 전개 순서, `combination` 은 축 값이 같은 반복들이 공유하는 번호, `repeat` 은 그
안에서의 순번이다. 셋을 하나로 뭉개면 "이 조합이 몇 번 중 몇 번 통과했나" 를 계산할 재료가
사라진다.

### CLI 는 세기까지만 한다

조합별 통과 횟수는 분모가 보이는 세기다. 평균도 분산도 내지 않는다 — `qa diff` 가 비율 대신
합을 다루는 것과 같은 규율이고, 그 위의 통계는 이 목록을 읽는 쪽이 낸다.

### 반복이 없으면 통과 횟수 줄을 적지 않는다

`--repeat` 을 쓰지 않은 사람에게는 조합 줄을 그대로 다시 적는 것이 되어 아무것도 더하지 않는다.
`describeCombination` 의 `repeat=1/1` 도 같은 이유로 붙이지 않는다.

## Implementation

- `src/qa/matrix.ts` — `expandCombinations(axes, repeats)`, `MatrixCombination.combination`
  과 `.repeat`, `describeCombination(combination, repeats)`.
- `src/commands/qa/matrix.ts` — `repeats` 옵션, 시작 줄, 조합 payload.
- `src/output/contract.ts`, `src/output/human.ts` — `printRepeatTally`.
- `src/run.ts` — `--repeat`.
- `tests/qa-matrix.test.ts`, `README.md`

## Validation

- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`
- 2 조합에 `--repeat 3` 으로 6 런이 나오는지, `--repeat 1` 이 지금 번호를 그대로 두는지,
  같은 명령 두 번의 슬롯 배정이 같은지를 테스트로 본다.
