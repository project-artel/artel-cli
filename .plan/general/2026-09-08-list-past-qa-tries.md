# 2026-09-08 — artel qa list 로 지난 QA 시도를 찾는다

- Date: 2026-09-08
- Jira: ARTEL-852
- Status: Planned
- Based on: ARTEL-851 의 branch

## Goal

지난 시도를 다시 찾을 수 있게 한다. 각 줄이 그 시도가 속한 run id 를 함께 내서, 목록에서 본 것을
`qa show` 로 열 수 있다.

## Context

`qa show`·`qa watch`·`qa cancel` 은 전부 run id 를 인자로 받는데, 그 id 를 나열할 방법이 없다.
터미널을 닫으면 그 런은 CLI 로 다시 찾지 못한다.

### 서버가 실제로 내주는 것 (2026-09-08 확인)

이슈를 처음 쓸 때의 가정이 틀렸고, 계획 단계에서 확인한 것이 이렇다. 이슈 description 도 같은
내용으로 고쳤다.

- `GET /api/qa-tries` 가 유일한 목록이다 (`QaTryController.kt:59`). 받는 것은 `projectId` 와
  `size` 둘뿐이고 `size` 는 1..100 이다.
- 응답은 `QaTryResponse` 배열이다. `label` 이 없다 — 그 값은 `QaRunResponse` 에 있다.
- `qa_run` 목록 endpoint 는 없다. `QaRunController` 에 생성·단건 조회·취소뿐이다.

## Non-goals

- `--label` filter. 서버가 그 값을 목록에 내주지 않는다. ARTEL-861 로 올렸다.
- 여러 런을 접어 표로 내는 것. `qa diff` 의 일이다.

## Decisions

### 낼 수 있는 것은 try 목록이고, 각 줄에 run id 를 붙인다

이 목록을 읽는 이유가 `qa show <run id>` 로 가기 위해서다. try id 만 내면 목록이 있어도 그 다음
단계로 못 간다. `QaTry` 타입에 `qaRunId` 를 더한다 — 서버는 이미 그 필드를 내주고 있었고 CLI 가
읽지 않았을 뿐이다.

### `--status` 는 받은 것 안에서 거르고, 그렇게 말한다

서버에 상태 filter 가 없다. CLI 가 거르는 것을 숨기면 "이 프로젝트에 FAILED 가 하나뿐" 으로
읽힌다. `--json` 은 `fetched` 와 `limit` 을 함께 싣고, 사람 출력은 filter 를 쓴 경우 그 사실을
한 줄로 적는다.

### `--limit` 이 100 을 넘으면 서버 왕복 없이 거절한다

서버가 `size !in 1..100` 이면 400 이다. 그 400 을 받아 옮기는 것보다 미리 막는 쪽이 낫고,
`project list` 의 `--limit` 과 같은 판단이다.

## Implementation

- `src/http/qa.ts` — `QaTry.qaRunId`, `listQaTries`, `MAX_QA_TRY_LIST_SIZE`.
- `src/commands/qa/list.ts`
- `src/output/contract.ts`, `src/output/envelope.ts`
- `src/run.ts`
- `tests/qa-list-helpers.ts`, `tests/qa-list.test.ts`, `tests/json-contract.test.ts`

## Validation

- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`
- 가짜 서버로 목록·`--status`·`--limit 101` 을 빌드 산출물에서 확인한다.
