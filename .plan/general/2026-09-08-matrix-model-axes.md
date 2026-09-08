# 2026-09-08 — qa matrix 가 model 과 prompt version 과 reasoning effort 를 축으로 받는다

- Date: 2026-09-08
- Jira: ARTEL-855
- Status: Planned
- Based on: ARTEL-854 의 branch

## Goal

`qa matrix` 의 축을 셋에서 다섯으로 늘린다. 값이 하나면 그 축은 전 조합에 고정된다.

## Context

`MatrixAxes` 는 `testRunIds`·`contentMapModes`·`knowledgeModes` 셋이었다. `qa run` 과
`qa diff` 는 `model`·`promptVersion`·`reasoningEffort`·`arch` 네 축을 다루는데, matrix 는 그
넷을 축으로도 고정값으로도 받지 못했다.

두 가지가 동시에 막혀 있었다. model 을 바꿔 가며 재는 실험을 matrix 로 못 돌리고, model 을
고정할 수단도 없었다 — 축으로 주지 않으면 서버가 매 런마다 자기 기본값을 고르고, 그 기본값이
도는 중에 바뀌면 서로 다른 model 로 돈 결과가 한 표에 섞인다.

## Non-goals

- 조합 수 상한을 강제하는 것.
- work stealing. 재현이 처리량보다 앞선다는 판단을 유지한다.
- window label. `main` 에는 그 기능이 아직 없다(ARTEL-827 branch 에만 있다).

## Decisions

### 축 전개 순서는 선언 순서다

test run, model, prompt version, reasoning effort, content map mode, knowledge mode.
순서를 고정해야 같은 명령이 같은 조합에 같은 번호를 주고, 그래야 슬롯 배정도 두 번 다 같다.

### `--reasoning-max-tokens` 와 `--arch` 는 축이 아니다

앞의 것은 model 과 effort 가 정해진 뒤의 예산이라, 그 둘을 축으로 두고 이것까지 축으로 두면
서로 맞지 않는 조합이 곱해진다. 뒤의 것은 JSON object 하나여서 쉼표로 가를 수 없다. 둘 다 전
조합에 걸리는 고정값으로 받고, 이유를 `--help` 에 적는다.

### `--arch` 는 한 번만 읽는다

조합마다 다시 읽으면 matrix 가 도는 중에 그 파일이 바뀌었을 때 앞뒤 조합이 다른 구조로 돌고,
그 차이는 결과 어디에도 남지 않는다. `readArch` 를 `src/qa/arch.ts` 로 옮겨 `qa run` 과 함께
쓴다.

### 세 축은 CLI 가 값을 검증하지 않는다

`--content-map-mode` 와 `--knowledge-mode` 는 값 목록이 CLI 에 있어 미리 거절한다. 새 세 축은
목록이 서버에 있고, CLI 가 사본을 들면 서버보다 낡을 수 있다 — `artel qa models` 가 그 자리다.

### 시작 전에 슬롯당 대기열 길이를 말한다

축이 다섯이 되면서 조합 수가 곱으로 늘어난다. 슬롯 하나가 몇 개를 차례로 돌아야 하는지가 이
명령이 몇 시간짜리인지를 정하므로, 시작하기 전에 그것을 보고 그만둘 수 있어야 한다.

## Implementation

- `src/qa/matrix.ts` — `MatrixAxes`, `MatrixCombination`, `expandCombinations`,
  `describeCombination`.
- `src/qa/arch.ts` — `readArch` 를 `commands/qa/run.ts` 에서 옮겨 온다.
- `src/commands/qa/matrix.ts` — 새 축과 고정값, 요청 body, 대기열 길이.
- `src/output/contract.ts` — 조합 payload 에 축 셋.
- `src/run.ts` — flag 다섯.
- `tests/qa-matrix.test.ts`, `README.md`

## Validation

- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`
- model 두 개와 content map mode 두 개로 4 조합이 나오는지, 값 하나짜리 축이 고정되는지,
  같은 명령을 두 번 돌려 배정이 같은지를 테스트로 본다.
