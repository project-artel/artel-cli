# 2026-09-08 — artel issue 로 QA 가 찾은 이슈를 읽고 처리한다

- Date: 2026-09-08
- Jira: ARTEL-858
- Status: Planned
- Based on: ARTEL-857 의 branch

## Goal

QA 가 찾은 결함을 프로젝트 단위로 읽고, 해결 표시를 걸고 푼다.

## Context

CLI 는 런을 걸고 판정을 읽지만 그 런이 찾아낸 이슈를 프로젝트 단위로 읽지 못한다. `qa show`
가 그 런의 이슈를 함께 내는 것이 전부다.

### 서버가 실제로 내주는 것 (2026-09-08 확인)

- `GET /api/projects/:projectId/issues` — `status`, `severity`, `beforeId`, `size` 를 받는
  최신순 커서 페이지. 이번에는 진짜 서버 filter 다.
- `POST /api/issues/:id/resolve` 와 `/reopen` — 둘 다 본문 없는 204.
- 이슈 하나를 읽는 경로는 없다.

## Non-goals

- `issue show`. 그 endpoint 가 없다.
- `tracker-sync`. 외부 tracker 연동 상태에 기댄다.
- 이슈를 CLI 에서 만드는 것. 이슈는 QA 런이 만든다.

## Decisions

### 커서를 감추지 않는다

`nextBeforeId` 와 `hasMore` 를 payload 에 싣고 사람 출력이 다음 커서를 말한다. 감추면 받은 것이
전부인 줄 알고 없는 이슈를 없다고 읽는다.

### 쓰기 payload 는 되읽은 값이 아니다

서버가 204 를 내고 본문이 없다. 바뀐 이슈를 되읽어 오는 경로도 없다. 그래서 payload 는 CLI 가
아는 사실만 싣는다 — 어느 이슈에 어느 명령을 걸었고 그것이 성공했다는 것. 이슈 객체를 지어내면
그것이 실제 상태라고 읽힌다.

### 목록 줄에 run id 를 붙인다

이슈를 보고 다음에 하는 일은 그 런을 여는 것이다. `qa show` 가 받는 것이 run id 이므로 그것이
없으면 문맥으로 갈 수 없다.

## Implementation

- `src/http/issues.ts`, `src/issue/context.ts`
- `src/commands/issue/list.ts`, `src/commands/issue/status.ts`
- `src/output/contract.ts`, `src/output/envelope.ts`, `src/errors.ts`
- `src/run.ts`
- `tests/issue.test.ts`, `README.md`

## Validation

- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`
- 가짜 서버로 filter 가 query 로 나가는지, `hasMore` 일 때 커서를 말하는지, 없는 이슈에
  `resolve` 를 걸면 읽을 수 있는 404 가 나오는지 본다.
