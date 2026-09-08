# 2026-09-08 — login 이 저장한 apiBaseUrl 을 이후 명령이 기본값으로 쓴다

- Date: 2026-09-08
- Jira: ARTEL-850
- Status: Planned
- Based on: ARTEL-849 의 branch (`auth status` payload 를 같은 자리에서 고친다)

## Goal

`--api-url`, `ARTEL_API_BASE_URL`, 자격증명 파일의 `apiBaseUrl` 순으로 주소를 정한다. 로그인한
사람은 명령마다 주소를 다시 적지 않는다.

## Context

`StoredCredential` 에 `apiBaseUrl` 이 이미 있고 (`src/credentials/types.ts:16`), `auth login` 은
그 값을 파일에 적는다. 그런데 `resolveApiBaseUrl` (`src/config.ts:51`) 은 flag 와 환경 변수만
본다. 파일에 적힌 값을 읽는 곳은 `auth status` 의 보고뿐이고, 아무 명령도 그것을 쓰지 않는다.

주소를 명령마다 손으로 적으면 staging 자격증명으로 운영을 부르는 사고가 열린다.

## Non-goals

- profile 여러 개.
- `ARTEL_CONSOLE_BASE_URL` 의 기본값 변경.
- 다섯 개 `*/context.ts` 를 하나로 합치는 것. `testRuns/context.ts` 의 주석이 별도로 두는 이유를
  이미 적어 두었다 — 도메인이 다르고, 이름이 `resolveQaContext` 인 함수를 test run 명령이
  부르면 읽는 사람이 두 도메인이 얽혀 있다고 오해한다. 이 이슈는 그 판단을 뒤집지 않는다.

## Decisions

### `config.ts` 는 파일을 읽지 않는다

의존 방향이 `commands` → `credentials` · `config` 이고 그 반대 간선이 없다. `config.ts` 가
자격증명 파일을 읽으면 그 방향이 깨진다. 대신 부르는 쪽이 이미 읽은 값을 인자로 넘긴다.

### 우선순위를 아는 자리는 하나다

`effectiveApiBaseUrl(env, stored)` 하나가 환경 변수와 파일 사이의 순서를 안다.
`resolveApiBaseUrl` 은 그 위에 flag 층과 검증과 실패를 얹는다. `auth status` 는 검증 없이
`effectiveApiBaseUrl` 만 부른다 — 보고하는 명령이 값이 이상하다고 죽으면 안 되고, 그 값이 실제로
쓰이는 자리에서 `invalid_base_url` 로 걸린다.

### `ARTEL_TOKEN` 으로 인증하면 파일을 읽지 않는다

`resolveCredential` 이 이미 그렇게 되어 있다 — 환경 변수가 이기면 파일을 아예 읽지 않는다.
권한이 망가진 파일 하나가 CI 를 멈추면 안 되기 때문이다. 주소도 같은 규칙을 따른다. 환경 변수로
들어온 token 에는 짝지어진 주소가 없고, 남의 파일에 적힌 주소를 그 token 에 붙이면 CI 가 자기가
어디에 붙는지 모르게 된다.

### 자격증명을 먼저 읽고 주소를 나중에 정한다

파일의 값을 넘기려면 순서가 그렇게 될 수밖에 없다. 결과로 "로그인도 안 했고 주소도 없는" 경우의
오류가 `missing_api_base_url` 에서 `no_credential` 로 바뀐다. 둘 다 참이고, 고치는 방법이 하나뿐인
쪽을 말하는 것이 낫다 — `artel auth login` 한 번이 자격증명과 주소를 함께 채운다.

### `auth login` 은 이 규칙에서 빠진다

login 이 파일의 주소를 기본값으로 쓰면, 그 파일이 mode 나 version 때문에 읽히지 않는 상태에서
login 자체가 막힌다. 그 상태를 고치려고 부르는 명령이 그 상태에 발이 묶이는 것이다. login 은
지금처럼 flag 와 환경 변수만 본다.

### `auth status` 의 `apiBaseUrl` 은 실제로 쓰일 값이 된다

지금은 파일에 적힌 값만 낸다. 그대로 두면 환경 변수가 이기는 상황에서 status 가 말한 주소와
명령이 실제로 부르는 주소가 다르다. 출처는 새 키 `apiBaseUrlSource` 로 말한다. 키를 더하는 것은
계약을 깨지 않는다.

## Implementation

- `src/config.ts` — `effectiveApiBaseUrl` 을 새로 두고, `resolveApiBaseUrl` 과 `resolveConfig` 이
  파일 값을 받게 한다. 실패 메시지에 로그인 경로를 더한다.
- `src/qa/context.ts`, `src/case/context.ts`, `src/scenario/context.ts`,
  `src/testRuns/context.ts`, `src/doc/context.ts` — 자격증명을 먼저 읽고 그 값을 넘긴다.
- `src/commands/game/start.ts`, `src/commands/game/logout.ts`, `src/commands/qa/matrix.ts` —
  같은 순서로 바꾼다.
- `src/output/contract.ts`, `src/commands/auth/status.ts`, `src/output/human.ts` —
  `apiBaseUrlSource` 를 더하고 `apiBaseUrl` 의 뜻을 실제 값으로 맞춘다.
- `tests/config.test.ts`, `tests/json-contract.test.ts`, `tests/store.test.ts` 근처에 테스트를 더한다.

## Validation

- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`
- 환경 변수 없이 자격증명 파일만 둔 상태에서 명령이 주소 없이 도는지 본다.
- `ARTEL_TOKEN` 과 파일이 둘 다 있는 상태에서 파일 주소를 쓰지 않는지 본다.
