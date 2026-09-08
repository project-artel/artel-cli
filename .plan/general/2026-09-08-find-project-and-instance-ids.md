# 2026-09-08 — artel project list 와 artel game list 로 id 를 찾는다

- Date: 2026-09-08
- Jira: ARTEL-851
- Status: Planned
- Based on: ARTEL-850 의 branch (로그인한 주소를 기본값으로 쓰는 동작 위에서 검증한다)

## Goal

`--project` 와 `--instance` 에 넣을 id 를 CLI 로 찾는다.

## Context

거의 모든 명령이 `--project` 를 요구하고 `qa run` 은 `--instance` 를 요구하는데, 그 두 id 의
출처가 콘솔 아니면 `game start` 가 등록 직후에 찍은 한 줄뿐이다. 터미널만으로 QA 를 돌린다는
것이 성립하지 않는다.

서버에는 둘 다 있다. `GET /api/projects` 와 `GET /api/projects/:id/game-instances` 이고,
후자는 CLI 가 이미 부르고 있다 — `game/registration.ts` 가 launch 전후로 두 번 불러 차이를
본다. 사람에게 보여 주는 자리만 없었다.

## Non-goals

- 프로젝트를 만들고 고치고 지우는 것.
- game instance 이름 수정과 초기화. 초기화는 ARTEL-802 다.
- README 전체 정리. ARTEL-860 이다. 여기서는 `projects list` 표기와 이 두 명령의 절만 손댄다.

## Decisions

### 명령 이름은 단수 `project` 다

`case`, `scenario`, `run`, `doc` 가 전부 단수다. README 가 적어 둔 `projects list` 는 그 규칙과
어긋나므로 문서 쪽을 고친다.

### `project list` 는 페이지를 감추지 않는다

서버가 `items`·`page`·`size`·`total` 로 답하고 `size` 를 100 에서 자른다. 봉투를 그대로 싣고
사람 출력이 남은 개수와 다음 `--page` 를 말한다. 조용히 자르면 101 번째 프로젝트가 없는 것으로
읽힌다.

`--limit` 이 100 을 넘으면 서버 왕복 없이 거절한다. 서버가 조용히 잘라 주면 CLI 가 `total` 과
받은 개수의 차이를 페이지 탓으로 보고하는데, 실제로는 요청이 잘린 것이다.

### `game list` 는 연결 상태를 id 다음에 적는다

`qa run` 은 붙어 있는 instance 에만 걸린다. 목록에서 무엇을 고를지 실제로 가르는 값이 그것이라
이름보다 앞에 둔다. 떨어져 있으면 마지막으로 붙었던 시각을 함께 적는다 — 방금 죽은 것과 한 번도
안 붙은 것은 다음에 할 일이 다르다.

### context module 을 둘 더 만든다

`project/context.ts` 와 `game/context.ts` 다. 내용이 기존 다섯과 같지만,
`testRuns/context.ts` 의 주석이 별도로 두는 이유를 이미 적어 두었다 — 도메인이 다르고, 이름이
`resolveQaContext` 인 함수를 다른 도메인 명령이 부르면 두 도메인이 얽혀 있다고 읽힌다. 이
이슈에서 그 판단을 뒤집지 않는다.

`game/context.ts` 는 `game start`·`game logout` 이 쓰지 않는다. 그 둘은 빌드에
`-artel-frontend` 를 넘겨야 해서 console 주소까지 필요하고 `resolveConfig` 를 직접 부른다.

## Implementation

- `src/http/projects.ts` — `GET /api/projects` 와 응답 parsing.
- `src/project/context.ts`, `src/game/context.ts`
- `src/commands/project/list.ts`, `src/commands/game/list.ts`
- `src/output/contract.ts`, `src/output/envelope.ts` — payload 넷과 union.
- `src/run.ts` — `project` 명령군과 `game list` 등록, `--page` 파서.
- `tests/discovery-helpers.ts`, `tests/discovery.test.ts`, `tests/json-contract.test.ts`
- `README.md` — `projects list` 표기와 새 절.

## Validation

- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`
- 가짜 서버를 띄워 두 명령의 사람 출력과 `--json` 을 실제로 확인한다.
- 참여하지 않은 프로젝트 id 로 `game list` 를 불러 404 가 읽을 수 있는 문장으로 나오는지 본다.
