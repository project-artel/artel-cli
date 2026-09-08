# 2026-09-08 — artel --version 이 자기 버전을 말한다

- Date: 2026-09-08
- Jira: ARTEL-849
- Status: Planned

## Goal

`artel --version` 과 `artel -V` 가 `package.json` 의 버전을 한 줄로 내고 exit 0 으로 끝난다.
`auth status` 도 같은 값을 보고한다.

## Context

`runCli` 가 `commander` 에 `.version()` 을 걸지 않아 `artel --version` 이
`error: unknown option '--version'` 으로 exit 2 를 낸다. `src/run.ts` 의 `report` 는 이미
`--help` 와 `--version` 이 실패가 아니라고 적어 두었는데, 그 자리로 올 `--version` 자체가 없다.

패키지는 `@project-artel/cli` 로 배포되고 있고 지금 값은 `0.0.1-alpha.0` 이다. 사용자가 어느
버전을 깔았는지 그 도구에게 물을 수 없다.

## Non-goals

- 버전을 올리는 것과 태그를 붙이는 것. `release.yml` 이 태그와 `package.json` 을 대조한다.
- update 확인이나 최신 버전 알림.

## Decisions

### 버전의 근거는 `package.json` 하나다

소스에 문자열로 한 번 더 적으면 두 값이 어긋난다. `release.yml` 이 태그와 `package.json` 을
대조해 배포를 막는 것도 그 파일을 근거로 두었기 때문이다. 같은 근거를 쓴다.

### `import.meta.url` 기준으로 읽는다

`tsconfig.build.json` 의 `rootDir` 이 `src` 이고 `outDir` 이 `dist` 라, `src/version.ts` 는
`dist/version.js` 가 된다. 두 자리 모두에서 `../package.json` 이 패키지 root 를 가리킨다.
`process.cwd()` 로 읽으면 사용자가 어느 디렉터리에서 부르느냐에 따라 남의 `package.json` 을
읽는다.

`files` 가 `dist` 만 담고 있어도 npm 은 `package.json` 을 항상 함께 올리므로 설치본에서도
읽힌다.

### 읽지 못하면 `null` 이고, 그것을 `unknown` 으로 말한다

버전 한 줄을 못 읽었다고 모든 명령이 죽는 것은 과하다. 반대로 못 읽은 자리에 그럴듯한 숫자를
지어내면 버그 보고가 거짓을 담는다. 읽기에 실패하면 `--version` 은 `unknown` 을 내고,
`auth status --json` 의 `cliVersion` 은 `null` 이다. 모르는 값은 `null` 이라는 계약 그대로다.

### `auth status` 에 필드를 더한다

버그 보고에 붙이는 것은 대개 `auth status --json` 한 덩어리다. 버전이 거기 없으면 두 번
물어야 한다. 키를 더하는 것은 계약을 깨지 않는다 — 계약이 금지하는 것은 키를 지우거나 이름을
바꾸는 것이다.

## Implementation

- `src/version.ts` — `package.json` 을 읽어 `version` 을 돌려주는 함수 하나. 한 번 읽고 캐시한다.
- `src/run.ts` — `program.version()` 을 건다.
- `src/output/contract.ts` — `StatusPayload` 에 `cliVersion: string | null` 을 더한다.
- `src/commands/auth/status.ts` — payload 에 값을 싣는다.
- `src/output/human.ts` — `printStatus` 가 한 줄 더 적는다.
- `tests/json-contract.test.ts` — `STATUS_KEYS` 에 `cliVersion` 을 더한다.
- `tests/version.test.ts` — `--version` 과 `-V` 가 `package.json` 의 값을 내고 exit 0 인지 본다.

## Validation

- `npm test`
- `npm run build` 뒤 `node dist/cli.js --version` 이 `package.json` 의 값과 같은지 본다.
- `npm pack` 으로 만든 tarball 을 풀어 `dist` 와 `package.json` 이 함께 들어 있는지 본다.
