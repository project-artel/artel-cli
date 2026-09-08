# 2026-09-08 — artel map 으로 content map 을 읽는다

- Date: 2026-09-08
- Jira: ARTEL-859
- Status: Planned
- Based on: ARTEL-858 의 branch

## Goal

`--content-map-mode` 를 축으로 재는 실험에서, 그 arm 의 map 이 무엇을 담고 있었는지 CLI 로 본다.

## Context

`artel doc scan` 은 스캔을 걸 뿐 결과를 읽지 않는다. map 이 비어 있었던 것인지 내용이 틀렸던
것인지 CLI 로 구분할 수 없었다.

`GET .../content-map` 은 지도가 없어도 200 이다. 빌드는 있고 접근도 되며, 없는 것은 아직 아무도
올리지 않은 문서다.

## Non-goals

- `artel map regenerate`. 그 endpoint 는 `/internal/` 아래이고 `SecurityConfig` 가 그 접두사를
  통째로 `permitAll` 로 둔다 — 서버-투-서버 신뢰 경계라 사용자별 접근 검사가 없다. 사용자
  도구가 부르면 아무나 남의 프로젝트 test case 를 다시 만들 수 있다. 엔드유저 경로가 필요하고
  그것은 ARTEL-864 다.
- content map 을 손으로 고치는 것.

## Decisions

### 두 "없음" 을 갈라 적는다

`contentMap` 이 `null` 인 것과 `contentMap.ingestedAt` 이 `null` 인 것은 다음에 할 일이 다르다.
앞은 문서를 올리는 것이고 뒤는 앉기를 기다리거나 왜 못 앉았는지 보는 것이다.

### `lastScan` 이 `null` 인 것은 "스캔이 없었다" 가 아니다

서버가 뜬 뒤로 이 빌드에 스캔을 시킨 적이 없다는 뜻이다. 지도가 스캔 없이 생겼다는 뜻으로
읽히면 지도의 출처를 오해한다.

### `--watch` 뒤에도 지도는 조회로 읽는다

stream 의 마지막 frame 을 그대로 쓰면, 붙기 전에 끝난 스캔과 붙어서 본 스캔이 서로 다른 값을
말하게 된다. 조회를 한 번 더 하는 값이 그 일관성이다.

### `watchScan` 을 재사용한다

`doc scan --watch` 가 쓰는 loop 그대로다. 다른 것은 "방금 내가 시킨 스캔" 이 없다는 것뿐이라,
그 인자를 nullable 로 바꾸고 timeout 메시지가 게임 이름을 못 댈 때를 문장으로 갈랐다.

### 세는 값만 낸다

씬과 기능 원문은 콘솔이 그린다. `--json` 은 지도 전체가 아니라 수들이다.

## Implementation

- `src/http/contentMap.ts` — `readContentMap`, `ContentMapView`.
- `src/doc/scan-flow.ts` — `watchScan` 을 export 하고 `requested` 를 nullable 로.
- `src/commands/map/show.ts`
- `src/output/contract.ts`, `src/output/envelope.ts`, `src/run.ts`
- `tests/doc-helpers.ts` — 가짜 서버에 조회 경로.
- `tests/map-show.test.ts`, `README.md`

## Validation

- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`
- 지도가 있는 경우, 문서가 없는 경우, 등록만 되고 앉지 않은 경우, 마지막 스캔이 실패한 경우,
  스캔 기록이 없는 경우를 테스트로 본다.
