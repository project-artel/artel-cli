# 2026-09-08 — 서버에 이미 있는 endpoint 를 없다고 적은 문서를 고친다

- Date: 2026-09-08
- Jira: ARTEL-847
- Status: Planned
- Based on: ARTEL-859 의 branch (README 를 같은 자리에서 고친다)

## Goal

`artel auth login` 과 `artel game start` 가 기대는 endpoint 가 "아직 없다" 고 적은 네 자리를
사실에 맞춘다.

## Context

README 맨 위 블록, `src/http/client.ts` 의 주석 둘, `src/auth/login-flow.ts` 의 주석 하나가
그 endpoint 들이 서버에 없다고 적는다.

## 확인한 방법

로컬 orchestration server(8080)가 이미 떠 있었다. 브라우저 왕복은 GitHub OAuth 세션이 필요해
헤드리스로는 못 돌리므로, 대신 서버 자신이 무엇을 갖고 있는지 물었다.

- `POST /api/auth/cli-tokens/exchange` 에 잘못된 코드를 보내 **400 `invalid_login_code`** 를
  받았다. 그 endpoint 가 자기 검증을 돌렸다는 뜻이고, 404 가 아니다.
- 서버의 OpenAPI 문서(`GET /v3/api-docs`, 경로 97 개)에 `/api/auth/cli-tokens/exchange` 와
  `/api/auth/sdk-tokens` 가 둘 다 `post` 로 등재되어 있다.

`/api/auth/sdk-tokens` 를 요청으로만 확인하지 못한 이유도 적어 둔다. 그 경로는 인증이 필요하고,
없는 경로도 Spring Security 가 라우팅 전에 401 로 막아서 둘이 구별되지 않는다. OpenAPI 문서가
그 구별을 준다.

## Non-goals

- login flow 의 동작을 바꾸는 것.
- 404 처리와 두 오류 코드를 없애는 것. 배포마다 다르므로 그 처리는 여전히 옳다.

## Decisions

### 404 처리는 남기되 문장을 바꾼다

"이 기능은 아직 없다" 가 아니라 "이 서버에 그 경로가 없다 — 배포가 낡은 것 같다" 로 적는다. CLI
는 자기가 가리키는 서버가 어느 버전인지 모르고, 그것이 이 처리가 존재하는 이유다.

### `AGENTS.md` 의 절 제목도 고친다

"A token while the login command does not exist yet" 는 이제 거짓이다. 토큰을 손으로 mint 하는
이유는 login 이 없어서가 아니라, 그 flow 가 브라우저와 콘솔 세션을 요구하고 agent 에게는 그
둘이 없기 때문이다.

## Implementation

- `README.md` 맨 위 블록
- `src/http/client.ts` — 주석 둘과 404 메시지 둘
- `src/auth/login-flow.ts` — 주석 하나
- `AGENTS.md` — 절 제목과 첫 문단
- `tests/exchange.test.ts` — 404 메시지를 보는 테스트

## Validation

- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`
