# 2026-09-08 — qa show 와 qa matrix 가 런의 token 사용량과 비용을 싣는다

- Date: 2026-09-08
- Jira: ARTEL-854
- Status: Planned
- Based on: ARTEL-853 의 branch

## Goal

런과 try 가 쓴 token 과 비용을 `--json` 과 사람 출력에 싣는다. `qa matrix` 의 조합별 결과에도
같은 값을 싣는다.

## Context

두 arm 을 비교할 때 "어느 쪽이 더 맞혔나" 만 나오고 "얼마를 써서 그랬나" 가 빠진다. content map
을 켠 arm 이 정확도를 조금 올리면서 token 을 두 배 쓴다면 그것은 다른 결론이다.

### 서버가 실제로 내주는 것 (2026-09-08 확인)

- `GET /api/llm-usage/qa-runs/:qaTryId` — 이름은 `qa-runs` 인데 경로 변수는 `qaTryId` 다. 지출은
  run 이 아니라 try 에 귀속되고, 한 run 에는 시나리오마다 try 가 있으므로 런 값은 그 합이다.
- `LlmUsageTotals` 는 `inputTokens`, `outputTokens`, `cachedInputTokens`, `reasoningTokens`,
  `costUsd`, `calls`, `pricedCalls` 다.

## Non-goals

- 비용 예산과 상한. 서버의 일이다.
- 프로젝트 단위 사용량 집계 명령.

## Decisions

### 합만 더한다

`qa diff` 가 셀을 합칠 때 지키는 규율과 같다. 이 payload 에는 평균도 비율도 없다.

### `costUsd` 가 없는 것과 0 인 것을 구별한다

단가를 아는 호출이 하나도 없으면 `null` 이다. 0 으로 접으면 단가를 안 알려주는 provider 로
돌린 arm 이 공짜였던 것으로 읽히고, 그런 표로 arm 비용을 비교하면 결론이 틀린다. 금액이 몇 건의
호출에 얹혔는지는 `pricedCalls` 와 `calls` 가 말한다.

### 사용량을 못 읽어도 런 보고는 실패하지 않는다

판정을 읽는 것과 비용을 읽는 것은 다른 질문이다. 비용 endpoint 가 404 이거나 죽었다고
`qa show` 가 판정을 못 내면, 그 런이 통과했는지 물으러 온 사람이 답을 못 받는다. 읽지 못한
것은 `null` 이고, 그것은 지출이 0 이었다는 뜻이 아니다 — 사람 출력은 `not read` 라고 적는다.

### `cachedInputTokens` 를 `inputTokens` 에 더하지 않는다

서버 DTO 의 주석대로 포함된 값이다. 더하면 두 번 센다.

### 요청은 try 마다 하나다

`qa show` 는 이미 try 마다 로그와 이슈를 읽는다. 왕복 수의 차수가 달라지지 않고, 같은
`Promise.all` fan-out 에 얹는다.

## Implementation

- `src/http/llmUsage.ts` — `getQaTryUsage`, `LlmUsageTotals`.
- `src/qa/usage.ts` — `sumUsage`, `toUsagePayload`.
- `src/qa/report.ts` — try 마다 읽고 런에 합을 싣는다. 실패는 `null` 로 삼킨다.
- `src/output/contract.ts`, `src/output/human.ts`, `src/commands/qa/matrix.ts`
- `tests/qa-helpers.ts` — 가짜 서버에 사용량 경로. 기록이 없는 try 는 404 다.
- `tests/qa-usage.test.ts`, `tests/qa-show.test.ts`, `tests/qa-matrix.test.ts`

## Validation

- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`
- try 둘의 합, 한쪽만 `costUsd` 가 있는 경우, 사용량 endpoint 가 404 인 경우를 테스트로 본다.
