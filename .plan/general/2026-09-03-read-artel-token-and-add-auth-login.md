# 2026-09-03 — ARTEL_TOKEN 을 읽고 artel auth login 을 만든다

- Date: 2026-09-03
- Jira: ARTEL-782
- Status: Implemented (server-side exchange endpoint still missing — see Open Questions 1)

## Goal

빈 저장소를 TypeScript 프로젝트로 세우고, `artel` 실행 파일이 자격 증명 하나를 확보·보고·삭제하는
세 명령을 갖게 한다.

- `package.json` 이 `artel` bin 과 `build` / `typecheck` / `test` / `lint` script 를 선언한다.
- `ARTEL_TOKEN` 이 있으면 그게 자격 증명이다. CI 는 이 경로만 쓴다.
- `artel auth login` 은 loopback server 를 띄우고 브라우저를 열어, `artel_` 로 시작하는 CLI token
  하나를 받아 home 아래 파일에 mode `0600` 으로 저장하고 그 경로를 알려 준다.
- `artel auth status` 는 어느 자격 증명을 무엇에서 얻었는지 말하되 token 자체는 절대 찍지 않는다.
- `artel auth logout` 은 저장 파일을 지우고, 이게 서버 쪽 revocation 이 아님을 출력에 적는다.
- 셋 다 `--json` 을 받고, 그 모양은 첫 릴리스부터 공개 계약이다.

## Non-goals

- `projects`, `run`, `qa` 명령 — 이 이슈는 `auth` 세 개만 만든다.
- npm publish — `package.json` 에 `"private": true` 를 넣어 실수로 publish 되지 않게 막고,
  해제는 release 이슈에서 한다.
- OS keychain (macOS Keychain, libsecret, DPAPI). CI 에는 없으니 그 경로는 실패 경로일 뿐이다.
- 로그인 없이 token 문자열을 붙여넣는 경로(`--token-stdin` 류). headless 는 `ARTEL_TOKEN` 이 이미
  덮는다. Open Questions 로 미룬다.
- `logout` 이 서버에 `DELETE` 를 보내는 것. 이슈가 명시적으로 "서버 쪽 revocation 이 아니다" 라고
  말하게 시켰고, 계정을 바꾸려고 logout 한 사람의 다른 머신 token 까지 죽이는 건 놀라운 동작이다.

## Context / Constraints

### 서버에 이미 있는 것 (2026-09-03 에 orchestration / home 저장소에서 확인)

- `SdkAuthController`(`@RequestMapping("/api/auth/sdk")`) — `SdkAuthController.kt:33`
  - `POST /api/auth/sdk/codes` = `issueCode` — `SdkAuthController.kt:49-59`. 브라우저 cookie session
    JWT 가 있어야 하고, `codeStore.issue(session.userId, request.codeChallenge)` 로 일회용 code 를 낸다.
  - `POST /api/auth/sdk/token` = `exchange` — `SdkAuthController.kt:69-88`. 인증 없이 열려 있다
    (`SecurityConfig.kt:148-169` 의 permit 목록에 `/api/auth/sdk/token` 이 들어 있다).
- DTO — `SdkAuthDtos.kt`: `SdkLoginCodeRequest(codeChallenge)` `:13-17`,
  `SdkLoginCodeResponse(code)` `:20`, `SdkTokenRequest(code, codeVerifier)` `:25-33`
  (`codeVerifier` 는 `@Size(min = 43, max = 128)`), `SdkTokenResponse(token, expiresAt, refreshToken,
  refreshExpiresAt, userId, displayName)` `:44-51`.
- `SdkLoginCodeStore` 는 Redis 다 — `SdkLoginCodeStore.kt:38`. key 는
  `"artel:sdk:login-code:" + sha256Base64Url(code)`(`:15`, `:96`), value 는 `"$userId:$codeChallenge"`
  라는 `:` 로 이은 문자열(`:56`, 파싱은 `:83-90`), TTL 은 `AuthProperties.sdkLoginCodeTtl` 기본 5분
  (`AuthProperties.kt:28`), 일회용 보장은 `GETDEL` 한 번(`SdkLoginCodeStore.kt:75`). PKCE 는
  `base64url(SHA-256(verifier))` 인 S256 고정이다(`:93-101`).
- relay page 는 이미 있다 — `SDK_LOGIN_PATH = '/sdk-login'`(`sdkLoginRequest.ts:11`),
  `SdkLoginPage`(`SdkLoginPage.tsx:17`). **query 는 `challenge`, `port`, `state` 셋뿐이고**
  (`sdkLoginRequest.ts:43-54`), `port` 는 숫자만 · `1024–65535` 로 검증되며(`:36-41`),
  loopback host 는 코드에 `127.0.0.1` 로 박혀 있고 파라미터로 받지 않는다(`:56-61`, open redirect
  회피). 콜백은 `http://127.0.0.1:{port}/callback?code=..&state=..` 로의 브라우저 navigation 이다
  (`:62-69`) — page 가 loopback 에 POST 하는 게 아니라, loopback 이 그 `GET` 을 받아야 한다.
- `aud=artel-sdk` JWT 는 `JwtService.issueSdkToken`(`JwtService.kt:94-108`)이 내고 audience 기본값은
  `artel-sdk`(`AuthProperties.kt:25`)다. end-user chain 의 `@Primary jwtDecoder` 는
  `artel-home` audience 를 요구하므로(`SecurityConfig.kt:244-258`), **SDK token 으로는 end-user API 를
  못 부른다** — 이슈에 적힌 그대로이고 코드로 확인된다.
- bearer 해석은 `cookieTokenConverter`(`SecurityConfig.kt:316-325`) — `Authorization` 헤더, 없으면
  `artel_access_token` cookie, 그 다음 무조건 JWT decode. `artel_` 로 시작하는 opaque token 을
  알아보는 경로는 지금 **없다**.
- **ARTEL-780 은 아직 어느 브랜치에도 올라오지 않았다.** `CliToken` entity·서비스·컨트롤러가 없고,
  `cli_token` 테이블 마이그레이션도 없다(최신은 `V85__create_email_verification.sql`). 지금까지
  `artel_` 는 cookie **이름**에만 쓰였다(`AuthProperties.kt:13,20`). 그러니 이 plan 은 ARTEL-780 의
  계약을 이슈에 적힌 문장으로만 믿고 쓴다.
- base URL: 콘솔은 `artel.auth.frontend-url`(env `ARTEL_HOME_URL`, 기본 `http://localhost:5173`,
  `AuthProperties.kt:8`)이고 허용 origin 에 `https://artel.kr`, `https://home.stage.artel.kr` 가 있다.
  artel-home 이 부르는 API 는 `VITE_ORCHESTRATION_URL` 기본 `http://localhost:8080`(`authApi.ts:4`).
  운영 API 호스트 문자열은 두 저장소 어디에도 없다 → Open Questions.

### 결정: `artel auth login` 이 `artel_` token 을 손에 넣는 경로

**브라우저에는 일회용 code 만 흐르고, `artel_` token 은 CLI 가 verifier 를 들고 하는 exchange
응답에서 딱 한 번 나온다.** 즉 지금 SDK 로그인과 같은 loopback + PKCE 왕복을 그대로 쓰되, 끝에서
JWT 대신 CLI token 이 나오게 한다. CLI 가 보내는 것은 다음 두 가지다.

1. 브라우저를 `{consoleBaseUrl}/sdk-login?challenge={S256 challenge}&port={port}&state={state}&kind=cli`
   로 연다. 기존 세 파라미터는 이름·형식 그대로 쓰고 `kind=cli` 하나만 더한다.
2. loopback 이 `code` 를 받으면
   `POST {apiBaseUrl}/api/auth/cli-tokens/exchange` 에
   `{"code": …, "codeVerifier": …, "name": …, "expiresInDays": 90}` 을 보내고,
   `POST /api/auth/cli-tokens` 와 **같은** 201 body `{"id","name","token","createdAt","expiresAt"}`
   를 받는다.

`kind` 는 code 를 낼 때(브라우저 쪽) 묶고, `name` 과 `expiresInDays` 는 exchange 때(CLI 쪽) 보낸다.
`kind` 를 code 에 묶어야 SDK 용 code 가 CLI token 으로 바뀌지 못하고, `name`/`expiresInDays` 는
verifier 를 쥔 쪽만 정할 수 있으니 브라우저를 거칠 이유가 없다. token row 는 issue 시점이 아니라
**exchange 시점에** 만든다 — 중간에 그만둔 로그인이 콘솔 목록에 유령 row 를 남기지 않는다.

접는 가지:

- **PKCE 로 `aud=artel-sdk` JWT 를 받아 그걸로 `POST /api/auth/cli-tokens` 를 부른다** — 안 된다.
  end-user chain 은 `artel-home` audience 만 통과시킨다(`SecurityConfig.kt:244-258`,
  `AuthProperties.kt:25`). 이걸 되게 하려면 SDK audience 를 end-user API 에 들이는 셈이라
  CLI token 하나 만들자고 훨씬 넓은 구멍을 내는 것이다.
- **relay page 가 자기 session 으로 token 을 만들어 `…/callback?token=artel_…` 으로 넘긴다** —
  안 한다. 평문 token 이 URL 에 실려 브라우저 history 와 loopback 의 request line 에 남고, "브라우저를
  지나가는 값은 verifier 없이는 쓸모없다" 는 PKCE 의 전제를 통째로 버린다. 이슈의 "평문 token 을
  로그나 에러 메시지에 절대 넣지 않는다" 와도 정면으로 어긋난다.
- **`POST /api/auth/sdk/token` 의 응답을 kind 에 따라 두 모양으로 만든다** — 안 한다.
  `SdkTokenResponse`(`SdkAuthDtos.kt:44-51`)는 이미 SDK 가 쓰는 계약이라, union 으로 바꾸면 SDK 쪽
  파싱이 깨진다. 응답 모양이 다르면 endpoint 를 나눈다.

이 경로에는 ARTEL-780 이 짓지 않는 서버 작업이 들어 있다. 무엇인지는 Open Questions 에 적었고,
그게 없으면 `artel auth login` 은 출시할 수 없다.

### 결정: 도구와 버전 (2026-09-03 npm registry 확인값)

| 자리 | 고른 것 | 근거 |
|---|---|---|
| runtime | Node `>=22.12.0` | `commander@15.0.0` 의 engines 가 정확히 `>=22.12.0`. Node 20 은 2026-04 에 EOL 이라 바닥으로 못 쓴다. 로컬은 v24.18.0. |
| 명령 파싱 | `commander@^15.0.0` | 의존성 0개, subcommand·`--json` 만 있으면 되는 표면에 딱 맞고 타입을 자체 제공한다. |
| 언어 | `typescript@~5.9.3` | 아래 참조. |
| 테스트 | `vitest@^4.1.11` | TypeScript 를 별도 loader 없이 그대로 실행한다. `node:test` 는 TS 를 돌리려면 loader 배선이 따로 필요하다. |
| lint | `eslint@^10.9.1` + `typescript-eslint@^8.69.0` | type-aware 규칙(`no-unsafe-assignment`, `no-unsafe-argument`)이 `coding-style.md` 의 "untyped payload map 금지" 를 기계로 강제한다. |
| format | `prettier@^3.9.6` | ESLint 10 은 formatting 규칙을 들고 있지 않다. |
| 타입 정의 | `@types/node` (설치 시점 최신, 확인값 `26.4.1`) | |

TypeScript 를 최신 `7.0.2` 가 아니라 `~5.9.3` 으로 고정하는 이유: `typescript-eslint@8.69.0` 의
peer 범위가 `typescript: >=4.8.4 <6.1.0` 이라, 7 을 고르면 type-aware lint 규칙을 통째로 포기해야
한다. 새 프로젝트의 첫날부터 `lint` 가 도는 게 native compiler 보다 값이 크다. TypeScript 7 은
`typescript-eslint` peer 범위가 열린 뒤 별도 이슈로 올린다.

`@biomejs/biome@2.5.11`(lint + format 한 도구)도 봤지만 접는다 — Biome 은 TypeScript compiler 를
쓰지 않아 TS 버전 문제에서 자유로운 대신 type-aware 규칙이 없고, 그러면 위의 강제가 사라진다.

`oclif` 는 plugin 아키텍처와 자체 빌드 파이프라인을 끌고 와서 명령 세 개에 과하고 순수 `tsc` 빌드와
싸운다. `yargs` 는 subcommand 타이핑이 약하다. `cac`/`citty` 는 가볍지만 subcommand help 가 얇다.

빌드는 bundler 없이 `tsc` 하나다 — ESM(`"type": "module"`), 출력은 `dist/`, `bin.artel` 은
`dist/cli.js`. TypeScript 는 `.ts` 맨 앞의 `#!` shebang 을 그대로 출력에 남긴다. publish 가 아직
non-goal 이라 실행 권한은 `npm link` 로 확인한다.

### 결정: 모듈 경계

```
src/
  cli.ts                  bin entry. shebang, Command tree 조립, error → exit code 매핑
  commands/auth/
    login.ts  status.ts  logout.ts
  credentials/
    paths.ts              파일 경로 계산 (ARTEL_CONFIG_DIR 우선)
    store.ts              읽기/쓰기/삭제, mode 0600 보장
    resolve.ts            해결 순서
    types.ts              StoredCredential, ResolvedCredential, CredentialReport
  auth/
    pkce.ts               verifier / challenge / state 생성
    loopback.ts           loopback server 한 판
    browser.ts            openBrowser
    login-flow.ts         위 셋을 엮는 오케스트레이션 (의존성 주입 지점)
  http/
    client.ts  errors.ts
  output/
    envelope.ts           --json 직렬화, error envelope
    human.ts              사람용 출력
  config.ts               apiBaseUrl / consoleBaseUrl
tests/
```

의존 방향은 `cli → commands → {auth, credentials, http} → config` 한 방향이고 역방향 간선은 없다.
구체적으로:

- `commands/*` 는 `node:fs` 도 `node:http` 도 직접 부르지 않는다. `credentials` 와 `auth` 를 부르고
  결과를 `output` 으로 넘기는 것만 한다.
- `credentials/*` 는 `http` 를 import 하지 않는다. 자격 증명을 푸는 일과 그걸 쓰는 일은 다른 일이다.
- `http/client.ts` 는 token **문자열**을 인자로 받는다. 스스로 자격 증명을 해결하지 않는다.
- **`output/*` 는 `ResolvedCredential` 을 아예 못 받는다.** `CredentialReport` 라는, `token` 필드가
  구조적으로 없는 타입만 받는다. "token 을 절대 찍지 않는다" 를 규율이 아니라 타입으로 막는다.

### 결정: 자격 증명 해결 순서

1. `ARTEL_TOKEN` 이 있고 trim 후 비어 있지 않으면 그것. source = `env`.
2. 아니면 credentials 파일. source = `file`.
3. 아니면 없음. source = `null`.

`ARTEL_TOKEN` 이 있는데 빈 문자열이거나 공백뿐이면 **없는 것으로 보고 다음으로 넘어간다.** secret 이
없는 CI job 은 변수를 빈 문자열로 export 하고, 거기서 모든 명령이 죽는 것보다 "설정 안 됨" 으로 읽는
쪽이 덜 놀랍다. 다만 조용히 넘기지는 않는다 — `envVarState` 를 `"empty"` 로 보고한다.

`--token` 전역 flag 는 만들지 않는다. 프로세스 인자에 실린 secret 은 같은 머신의 다른 사용자에게
`ps` 로 보인다. 그 자리는 `ARTEL_TOKEN` 이 이미 채운다.

### 결정: 파일 위치·모양·권한

- 경로는 `path.join(os.homedir(), '.artel', 'credentials.json')`. `ARTEL_CONFIG_DIR` 이 있으면 그
  디렉터리를 대신 쓴다(테스트가 진짜 home 을 건드리지 않게 하는 손잡이이기도 하다).
- XDG(`$XDG_CONFIG_HOME/artel/…`)는 접는다 — 플랫폼마다 경로가 갈려 문서와 에러 메시지가 두 벌이
  되는데, 이슈가 요구한 건 "home 아래 파일" 하나다.
- 파일 내용:

  ```json
  {
    "version": 1,
    "token": "artel_…",
    "tokenId": "…",
    "tokenName": "artel-cli@hostname",
    "createdAt": "2026-09-03T04:11:07Z",
    "expiresAt": "2026-12-02T04:11:07Z",
    "apiBaseUrl": "https://api.artel.kr"
  }
  ```

  `version` 은 나중에 모양을 바꿀 때 읽는 쪽이 분기할 자리다. 모르는 `version` 을 만나면 읽기를
  거부하고 다시 로그인하라고 말한다. `apiBaseUrl` 은 staging 에서 받은 token 을 운영에 쏘는 사고를
  사람이 알아채게 하려고 적어 두고 `status` 가 그대로 보여 준다 — 이번 이슈에서 이 값으로 사용을
  막지는 않는다(Open Questions).

- **0600 을 사후 수정이 아니라 생성 시점에 보장한다:**
  1. `fs.mkdir(dir, { recursive: true, mode: 0o700 })`.
  2. 같은 디렉터리 안에 `credentials.json.<pid>.<random>.tmp` 를 `fs.open(tmp, 'wx', 0o600)` 으로 연다.
     `wx` 라서 이미 있으면 실패한다 — 즉 우리가 만든 파일임이 보장되고, 그래야 `open` 의 mode 인자가
     실제로 적용된다(mode 는 기존 파일에는 무시된다).
  3. 그 fd 에 `fchmod(fd, 0o600)`. umask 가 owner write 까지 깎아 `0400` 으로 열리는 경우를 정확히
     `0600` 으로 되돌린다. 아직 아무도 열 수 없는 임시 파일이라 넓히는 위험이 없다.
  4. write → `fsync` → close → `fs.rename(tmp, final)`. rename 은 같은 디렉터리 안이라 atomic 이고,
     inode 를 통째로 갈아 끼우므로 이전 파일이 `0644` 였어도 결과는 `0600` 이다.
  5. rename 뒤 `fs.stat` 으로 `(mode & 0o077) === 0` 을 확인한다. 아니면 파일을 지우고
     `credential_file_mode` 로 실패한다 — WSL 의 DrvFs 나 exFAT 처럼 mode 를 무시하는 마운트에서
     조용히 세계에 읽히는 파일을 남기지 않는다.

  쓰고 나서 `chmod` 하는 순서는 쓰지 않는다. `open` 과 `chmod` 사이의 짧은 창 동안 파일이 남에게
  읽힌다.

- **읽을 때도 검사한다.** `(mode & 0o077) !== 0` 이면 읽기를 거부하고 `credential_file_mode` 로
  실패한다. `ssh` 가 private key 에 하는 것과 같은 판단이다.
- **Windows:** NTFS 는 POSIX mode bit 를 강제하지 않고 Node 의 `chmod` 는 read-only 속성만 건드리므로
  `0o600` 은 사실상 no-op 다. 그래서 Windows 에서는 0600 을 주장하지 않는다 — 파일은 그대로
  `%USERPROFILE%\.artel\credentials.json` 에 두되(`os.homedir()` 가 알아서 준다), 출력은 "이 파일은
  사용자 프로필 ACL 로 보호된다" 고 말하고 `--json` 의 `mode` 는 `null` 로 낸다(POSIX 는 `"0600"`).
  읽기 쪽 mode 검사도 Windows 에서는 건너뛴다. `icacls` 를 shell out 하지는 않는다 — 로그인 명령에
  테스트 불가능한 실패 표면을 새로 다는 일이다.

### 결정: loopback server

- `server.listen(0, '127.0.0.1')` — port 는 OS 가 고르고 `server.address().port` 로 읽는다.
  `0.0.0.0` 이나 `::` 에 바인드하지 않는다. 고정 포트 후보군(8976, 8977 …)은 접는다: 충돌하는 데다,
  다른 로컬 프로세스가 미리 그 자리를 차지하고 앉을 수 있다.
  relay page 가 `port` 를 `1024–65535` 로 검증하므로(`sdkLoginRequest.ts:36-41`) 바인드된 포트가 그
  범위 밖이면 닫고 한 번 더 시도한 뒤 `loopback_port` 로 실패한다.
- 흘러든 콜백 방어:
  - `state` 는 랜덤 32바이트 base64url. 콜백의 `state` 를 `crypto.timingSafeEqual` 로(길이가 같을
    때만) 비교한다.
  - `GET /callback` 만 답한다. 다른 method·path 는 404.
  - `Host` 헤더가 `127.0.0.1:<port>` 가 아니면 400 — 어떤 이름이 127.0.0.1 로 풀리는 DNS rebinding
    을 막는다.
  - PKCE: verifier 는 랜덤 32바이트 base64url(43자, 서버의 `@Size(min=43, max=128)` 안),
    challenge 는 `base64url(SHA-256(verifier))`, method 는 S256 고정(`SdkLoginCodeStore.kt:93-101`).
    URL 이나 history 에서 훔친 code 는 verifier 없이 교환되지 않는다.
  - 어긋난 요청은 400 을 주고 **listener 를 죽이지 않는다** — 지나가던 요청 하나가 진짜 로그인을
    끊으면 안 된다. 대신 10번까지만 세고 그 뒤엔 `loopback_abuse` 로 닫는다.
  - 맞는 콜백 하나를 받으면 즉시 `server.close()` 한다. 창은 요청 한 번 폭이다.
  - 응답은 `Cache-Control: no-store` 를 단 작은 HTML 이고 `code` 를 본문에 되비추지 않는다.
- 타임아웃은 브라우저를 연 시점부터 **180초**. 서버 code TTL 이 5분이라(`AuthProperties.kt:28`) 그
  안이고, 비밀번호와 MFA 를 넣기에는 넉넉하다. 시간이 다하면 server 를 닫고 `login_timeout` 으로
  실패한다. 타임아웃 값은 주입 가능한 인자다(테스트가 50ms 로 내린다).
- 브라우저 열기는 의존성 없이 직접 짠다: darwin 은 `open`, win32 는 `cmd /c start ""`, linux 는
  `xdg-open`. WSL(`/proc/version` 에 `microsoft`)이면 `wslview`, 없으면
  `powershell.exe -NoProfile -Command Start-Process`. **어느 경우든 URL 을 먼저 화면에 찍고** 나서
  열기를 시도하고, 열기가 실패해도 계속 기다린다 — headless 에서도 사람이 손으로 열면 된다.
  `open` npm 패키지는 접는다: 우리에게 필요한 건 이 20줄뿐이고, 나머지는 의존성 트리다.

### 결정: `--json` 계약

세 명령 모두 성공하면 아래 object 를 stdout 에 한 줄로 낸다. **키는 사라지지 않는다** — 모르는 값은
`null` 이다. 키를 지우거나 이름을 바꾸는 것이 breaking change다.

`artel auth login --json`:

```json
{
  "authenticated": true,
  "source": "file",
  "credentialsPath": "/home/yunseong/.artel/credentials.json",
  "mode": "0600",
  "fingerprint": "a3f19c0b4d2e",
  "tokenId": "01JX…",
  "tokenName": "artel-cli@yunseong-wsl",
  "createdAt": "2026-09-03T04:11:07Z",
  "expiresAt": "2026-12-02T04:11:07Z",
  "apiBaseUrl": "https://api.artel.kr"
}
```

`artel auth status --json`:

```json
{
  "authenticated": true,
  "source": "env",
  "envVarState": "used",
  "credentialsPath": "/home/yunseong/.artel/credentials.json",
  "credentialsFileExists": true,
  "mode": "0600",
  "fingerprint": "a3f19c0b4d2e",
  "tokenId": null,
  "tokenName": null,
  "expiresAt": null,
  "apiBaseUrl": null
}
```

`artel auth logout --json`:

```json
{
  "removed": true,
  "credentialsPath": "/home/yunseong/.artel/credentials.json",
  "tokenId": "01JX…",
  "serverSideRevoked": false
}
```

값의 규칙:

- `source` 는 `"env" | "file" | null`. `envVarState` 는 `"used" | "empty" | "unset"` 셋뿐인 닫힌 집합.
- **`token` 필드는 어디에도 없다.** `--json` 출력은 CI 로그로 곧장 흘러 들어간다. token 이 필요한
  프로그램은 `credentialsPath` 를 읽으면 된다.
- `fingerprint` 는 `sha256(token)` 의 앞 12 hex 다. token 이 아니고 되돌릴 수도 없지만, 머신 두 대를
  구별하고 콘솔의 어느 row 인지 짚는 데는 충분하다.
- `mode` 는 POSIX 에서 `"0600"`, Windows 에서 `null`.
- `source` 가 `"env"` 면 `tokenId`/`tokenName`/`expiresAt`/`apiBaseUrl` 은 전부 `null` 이다. 환경
  변수는 그 값을 들고 있지 않다.
- `serverSideRevoked` 는 언제나 `false` 다. 이 필드가 이슈가 요구한 "서버 쪽 revocation 이 아니다" 를
  기계가 읽을 수 있게 적은 것이다. 사람용 출력에도 같은 문장을 쓴다.
- 자격 증명이 아예 없을 때 `status` 는 `authenticated: false`, `source: null`,
  `fingerprint: null`, `credentialsFileExists: false` 를 내고 **exit code 는 0** 이다. 보고에
  성공했으니 성공이다. `set -e` 스크립트가 여기서 죽으면 안 된다.
- `logout` 은 지울 파일이 없어도 `removed: false` 와 exit code 0 이다. idempotent 하다.

실패하면 `--json` 은 **오직** 아래 envelope 만 stderr 가 아니라 stdout 에 내고 non-zero 로 끝난다.

```json
{"error": {"code": "login_timeout", "message": "…"}}
```

`code` 의 초기 집합: `login_timeout`, `login_state_mismatch`, `login_denied`, `loopback_port`,
`loopback_abuse`, `no_credential`, `credential_file_mode`, `credential_file_unreadable`,
`credential_file_version`, `network_error`, `server_error`. 여기 새 값을 더하는 건 breaking 이 아니고,
있던 값의 뜻을 바꾸는 건 breaking 이다.

exit code 는 `0`(성공) / `1`(실패) / `2`(사용법 오류) 셋뿐이다. 더 세분한 값은 만들지 않는다 —
기계가 원하는 구분은 `error.code` 가 이미 준다.

### 그 밖의 제약

- 모든 HTTP 요청에 `AbortSignal.timeout(30_000)`. 재시도는 하지 않는다 — token 발급은 idempotent 하지
  않다.
- HTTP 오류 타입은 status 와 서버가 준 `code`/`message` 만 담는다. 요청 헤더는 담지 않는다.
- 기본 token 이름은 `artel-cli@${os.hostname()}`, `--name` 으로 덮는다. 만료는 기본 90일,
  `--expires-in-days <n|never>` 로 덮고 `never` 는 `null` 로 보낸다(이슈가 정한 대로 90 은 caller 인
  이 CLI 의 기본값이다).
- 이미 자격 증명 파일이 있는 상태의 `login` 은 묻지 않고 덮어쓰고, 덮어썼다고 출력에 적는다.
  rename 이 통째로 갈아 끼우므로 반쯤 쓰인 파일이 남지 않는다.
- `ARTEL_API_BASE_URL`, `ARTEL_CONSOLE_BASE_URL` 로 두 base URL 을 덮을 수 있다. 전역 flag 는 두지
  않는다.

## Approach (Checklist)

- [x] **Step 0: Recon** — orchestration 의 `SdkAuthController.kt`, `SdkAuthDtos.kt`,
  `SdkLoginCodeStore.kt`, `AuthProperties.kt`, `SecurityConfig.kt`, `JwtService.kt` 와 home 의
  `sdkLoginRequest.ts`, `SdkLoginPage.tsx`, `authApi.ts` 를 읽어 위의 사실을 확인. ARTEL-780 이 아직
  없다는 것도 확인.
- [x] **Step 1: 프로젝트 세우기**
  - `package.json`: `"type": "module"`, `"private": true`, `"engines": {"node": ">=22.12.0"}`,
    `"bin": {"artel": "./dist/cli.js"}`, script 는 `build`(`tsc -p tsconfig.build.json`),
    `typecheck`(`tsc --noEmit`), `test`(`vitest run`), `lint`(`eslint .`),
    `format`(`prettier --write .`).
  - `tsconfig.json`(`strict`, `noUncheckedIndexedAccess`, `module: nodenext`) 와 빌드용
    `tsconfig.build.json`(테스트 제외), `eslint.config.js`(flat config, typescript-eslint
    `recommendedTypeChecked`), `.prettierrc`, `vitest.config.ts`.
  - `.gitignore` 는 이미 `node_modules/`, `dist/`, `*.tsbuildinfo` 를 덮는다 — 손대지 않는다.
- [x] **Step 2: credentials**
  - `credentials/types.ts` — `StoredCredential`, `ResolvedCredential`, `CredentialReport`
    (`token` 없음), `CredentialSource`.
  - `credentials/paths.ts` — `ARTEL_CONFIG_DIR` → `~/.artel`.
  - `credentials/store.ts` — 위의 `wx` + `fchmod` + `rename` 쓰기, mode 검사가 들어간 읽기, 삭제.
  - `credentials/resolve.ts` — env → file → 없음, `envVarState` 계산, `fingerprint` 계산.
- [x] **Step 3: login flow**
  - `auth/pkce.ts`, `auth/loopback.ts`, `auth/browser.ts`, `auth/login-flow.ts`.
  - `login-flow.ts` 는 `{ openBrowser, fetch, now, randomBytes, timeoutMs }` 를 인자로 받는다. 이
    주입 지점이 브라우저 없이 테스트하는 유일한 손잡이다.
  - `http/client.ts` 에 exchange 호출과 typed 응답
    (`CliTokenResponse { id, name, token, createdAt, expiresAt }`).
- [x] **Step 4: 명령과 출력**
  - `output/envelope.ts`(성공 object 와 error envelope 직렬화), `output/human.ts`.
  - `commands/auth/{login,status,logout}.ts`, `cli.ts` 에서 Command tree 조립과 error → exit code 매핑.
- [x] **Step 5: 테스트** — 아래 Validation.
- [x] **Step 6: 문서** — `.agents/docs/project.md` 의 Commands 표와 Architecture 의 TODO 를 실제
  값으로 채우고, `README.md` 에 `ARTEL_TOKEN` 과 자격 증명 파일 경로를 적는다.

## Validation

- **Commands to run:** `npm run typecheck` · `npm run lint` · `npm run build` · `npm test`,
  그리고 손으로 `npm link && artel auth status --json`.
- **테스트 목록:**
  - `resolve`: `ARTEL_TOKEN` 이 파일을 이긴다 / 빈 `ARTEL_TOKEN` 은 `envVarState: "empty"` 로 파일에
    넘어간다 / 둘 다 없으면 `authenticated: false` 에 exit 0.
  - `store`(POSIX 전용, win32 는 skip): 새로 만든 파일이 `0600` / 디렉터리가 `0700` / 미리
    `0644` 로 놓아둔 파일을 덮어써도 결과가 `0600` / `0640` 인 파일은 읽기를 거부하고
    `credential_file_mode` / 모르는 `version` 은 `credential_file_version`.
  - **loopback 을 브라우저 없이 돌리는 방법:** 테스트가 브라우저 역할을 한다. 주입한 가짜
    `openBrowser` 가 URL 을 받아 `challenge`/`port`/`state` 를 뜯어내고, 직접
    `GET http://127.0.0.1:{port}/callback?code=…&state=…` 를 친다. 서버 쪽은 mocking 라이브러리 없이
    `http.createServer` 를 `127.0.0.1:0` 에 하나 더 띄워 orchestration 서버 흉내를 낸다 — 그 가짜
    서버가 받은 `codeVerifier` 로 SHA-256 을 다시 계산해 앞서 받은 challenge 와 맞는지 확인하므로
    PKCE 왕복이 끝에서 끝까지 검증된다.
  - loopback 부정 경로: `state` 가 틀린 콜백은 400 이고 flow 를 끝내지 않으며, 이어서 온 올바른
    콜백은 정상 성공한다 / `GET /` 은 404 / `Host` 가 다르면 400 / 주입한 타임아웃 50ms 로
    `login_timeout`. `sleep` 대신 주입한 마감을 쓴다.
  - 바인드 확인: 서버 주소가 `127.0.0.1` 이고 포트가 `1024–65535`.
  - **`--json` 계약 테스트:** 세 명령 출력의 `Object.keys().sort()` 를 그대로 단언한다. 필드를
    지우거나 이름을 바꾸면 반드시 깨진다.
  - **redaction 테스트:** 가짜 서버로 login 을 끝까지 돌리고 stdout·stderr 를 모아, 발급된 token
    문자열이 어디에도 없음을 단언한다. 401 응답을 포매팅한 에러 메시지에도 없음을 단언한다.
- **Expected output:** 위 명령 넷과 테스트 전부 통과. 이 저장소에는 기존 테스트가 없으므로 baseline
  은 "테스트 0개" 다.

## Risks & Rollback

- **Risks:**
  - 가장 큰 위험은 코드가 아니라 의존성이다. ARTEL-780 이 exchange endpoint 를 짓지 않으면
    `artel auth login` 은 붙을 서버가 없다. `ARTEL_TOKEN` 경로와 `status`/`logout` 은 그와 무관하게
    완성되므로, 먼저 그 셋을 올리고 `login` 을 뒤에 붙이는 순서로 나눌 수 있다.
  - 파일 권한이 무시되는 마운트(WSL DrvFs, exFAT)에서 rename 뒤 검사가 걸려 로그인이 실패할 수 있다.
    실패가 조용한 유출보다 낫다는 판단이고, 메시지가 어느 경로인지 짚는다.
  - `--json` 모양은 첫 릴리스부터 계약이라 되돌리기가 비싸다. 그래서 키 집합을 테스트로 못 박았다.
- **Rollback steps:** 저장소 전체가 새 코드라 되돌릴 기존 동작이 없다. 문제가 생기면 해당 커밋을
  revert 하면 되고, 사용자 머신에 남는 부작용은 `~/.artel/credentials.json` 하나 —
  `artel auth logout` 이나 파일 삭제로 지운다.

## Deviations (2026-09-03, 구현하면서 생긴 차이)

1. **error code 를 셋 더했다** — `login_not_supported`, `missing_api_base_url`,
   `internal_error`. plan 이 "새 값을 더하는 건 breaking 이 아니다" 라고 정한 그대로다.
   `login_not_supported` 는 exchange endpoint 가 404 로 답할 때 나간다. 그 404 를 일반적인
   `server_error` 로 뭉개면 사용자는 자기 설정이 잘못된 줄 알게 되는데, 실제로는 서버가
   아직 CLI 로그인을 지원하지 않는 것이다.
2. **`login_state_mismatch` 와 `no_credential` 은 선언만 되어 있고 지금 아무 경로도 내지
   않는다.** plan 이 정한 대로 state 가 틀린 콜백은 flow 를 끝내지 않고 `loopback_abuse`
   쪽으로 한 번 세는 것으로 끝나고, 자격 증명이 없는 `status` 는 exit 0 으로 보고한다.
   두 값은 공개된 집합에 남겨 두되 던지지 않는다.
3. **`LoginFlowDeps` 에서 `now` 를 뺐다.** flow 안에서 시계를 읽는 자리가 없다 —
   `createdAt` 과 `expiresAt` 은 서버가 찍어 준다. 대신 `notify` 를 넣었다. 진행 상황을
   stderr 로 보내야 `--json` 의 stdout 에 payload 한 줄만 남는다.
4. **`mode` 는 파일의 실제 mode 를 4자리 8진수로 적는다.** plan 의 예시가 `"0600"` 인
   그 자리이고 정상 경로에서는 `"0600"` 이지만, 리터럴을 박는 대신 `stat` 값을 그대로
   보고한다. Windows 는 plan 대로 `null` 이다.
5. **`ARTEL_CONSOLE_BASE_URL` 의 기본값을 `https://artel.kr` 로 두었다.** plan 은 API base
   URL 만 Open Question 으로 남겼고, 콘솔 쪽은 `AuthProperties` 의 allowed origins 에 이
   문자열이 있다. `ARTEL_API_BASE_URL` 은 plan 대로 필수다.
6. **`src/run.ts` 를 `cli.ts` 와 `commands/*` 사이에 두었다.** plan 은 Command tree 조립과
   exit code 매핑을 `cli.ts` 에 두었지만, 그러면 프로세스를 띄우지 않고는 exit code 를
   테스트할 수 없다. `cli.ts` 는 shebang 과 `process.exitCode` 대입 두 줄만 남는다.
7. **`@eslint/js` 를 devDependency 로 더했다.** flat config 가 `js.configs.recommended` 를
   쓰는데 plan 의 표에는 그 패키지가 없었다.
8. **prettier 가 Markdown 을 건드리지 않게 `.prettierignore` 에 `*.md` 를 넣었다.**
   손으로 줄바꿈한 agent 문서와 이 plan 을 reflow 하면 진짜 변경이 formatting 에 묻힌다.

## Open Questions

1. **ARTEL-780 의 범위 변경 — 이게 없으면 `artel auth login` 은 출시 불가.** 이슈에 적힌 세
   endpoint 만으로는 브라우저 왕복이 `artel_` token 으로 끝나지 않는다. 필요한 것:
   - artel-home `sdkLoginRequest.ts:20-24,43-54` 의 `RelayRequest` 에 선택 파라미터
     `kind`(`'sdk' | 'cli'`, 기본 `'sdk'`)를 더하고 `SdkLoginPage.tsx:39-44` 가 그걸
     `createSdkLoginCode` 로 넘긴다. 화면 문구도 무엇을 승인하는지 구분해 말해야 한다.
   - `SdkLoginCodeRequest`(`SdkAuthDtos.kt:13-17`)에 `kind` 추가. 그러면
     `SdkLoginCodeStore` 의 value 가 `"$userId:$codeChallenge"` 라는 `:` 결합 문자열
     (`SdkLoginCodeStore.kt:56,83-90`)로는 부족해 JSON 값으로 바뀌어야 한다.
   - 새 endpoint `POST /api/auth/cli-tokens/exchange`, body
     `{code, codeVerifier, name, expiresInDays}`, 응답은 `POST /api/auth/cli-tokens` 와 같은 201
     body. `SecurityConfig.kt:148-169` 의 permit 목록에 `/api/auth/sdk/token` 옆으로 넣어야 한다
     (교환하는 쪽은 아직 자격 증명이 없다). `kind` 가 `cli` 가 아닌 code 는 거부한다.
   - token row 는 exchange 시점에 만든다.
   이걸 ARTEL-780 을 넓혀서 할지, 별도 이슈로 뗄지 결정이 필요하다.
2. **운영 API base URL 의 기본값.** 콘솔 쪽은 `https://artel.kr` / `https://home.stage.artel.kr` 가
   `AuthProperties` 의 allowed origins 에 문자열로 있지만, orchestration API 호스트는 두 저장소
   어디에도 없다(artel-home 은 `VITE_ORCHESTRATION_URL` 로 주입받는다, `authApi.ts:4`). 기본값을
   받기 전까지는 `ARTEL_API_BASE_URL` 을 필수로 두고, 없으면 그렇게 말하고 멈춘다.
3. **`fingerprint` 를 콘솔도 보여 줄 것인가.** ARTEL-780 이 token 을 SHA-256 으로 저장한다면 콘솔
   목록에도 같은 12 hex 를 띄울 수 있고, 그러면 "이 머신이 콘솔의 어느 row 인지" 가 눈으로 맞춰진다.
   저장 해시 알고리즘이 정해지면 확인한다.
4. **`apiBaseUrl` 불일치를 막을 것인가.** 지금은 파일에 적고 `status` 로 보여 주기만 한다. staging
   token 을 운영에 보내는 것을 아예 거부할지는 base URL 기본값(2번)이 정해진 뒤에 정한다.
5. **붙여넣기 경로.** headless 에서 브라우저 없이 token 을 넣는 `artel auth login --token-stdin` 은
   이번에는 만들지 않는다. `ARTEL_TOKEN` 으로 부족하다는 사례가 나오면 그때 별도 이슈로 연다.
6. **Windows ACL.** 지금은 mode 를 주장하지 않고 프로필 ACL 에 기댄다. Windows 에서 더 강한 보호가
   요구되면 `icacls` 대신 무엇을 쓸지 따로 정해야 한다.
