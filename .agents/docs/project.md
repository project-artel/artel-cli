# Project Context

Fill this document during project initialization. Agents must verify commands against repository configuration before running them.

## Overview

- Product: `artel`, the command line interface for the ARTEL platform
- Primary users: customers running QA from a terminal or from CI, and coding
  agents driving the same loop. Both read the same commands; the machine reader
  is served by `--json` rather than by a separate interface.
- Core domain: authenticated access to the orchestration server's end-user API,
  and launching a game build that carries the Artel SDK
- Runtime environment: Node.js `>=22.12.0` with TypeScript, built by `tsc`
  alone (no bundler). The package is ESM (`"type": "module"`).

## Architecture

- Entry points: `src/cli.ts`, built to `dist/cli.js` and declared as the `artel`
  binary. It does nothing but call `runCli` from `src/run.ts`, which assembles
  the `commander` tree and maps a thrown error to an exit code.
- Main modules:
  - `src/commands/auth/` — `login`, `status`, `logout`. These call `credentials`
    and `auth` and hand the result to `output`; they never touch `node:fs` or
    `node:http` directly.
  - `src/commands/game/` — `start`, `logout`. Same rule: they call
    `credentials` and `game`, and hand the result to `output`.
  - `src/credentials/` — `paths` (where the file lives), `store` (0600 read,
    write and remove), `resolve` (`ARTEL_TOKEN` before the file), `types`.
  - `src/auth/` — `pkce`, `loopback` (the `127.0.0.1` callback listener),
    `browser`, `login-flow` (the dependency injection point that lets the login
    tests run with no browser and no server).
  - `src/game/` — `launch-args` (the `-artel-*` argv and the `host:port`
    derived from `apiBaseUrl`), `process` (the injectable child-process
    spawner, `game start`/`game logout`'s equivalent of `openBrowser`),
    `registration` (diffs two `game-instances` snapshots to find the one this
    launch registered), `log-file` (`-logFile` path under `~/.artel/logs`),
    `start-flow` and `logout-flow` (the two orchestrations, each a dependency
    injection point like `auth/login-flow`).
  - `src/commands/doc/` — `upload`, `scan`. `upload` puts a PDF into a project;
    `scan` tells the game running a build to produce its `evidence` document.
    Both take `--watch`, which follows a Server-Sent Events stream instead of
    polling.
  - `src/doc/` — `context` (the API base URL and the credential the two
    commands share), `upload-flow` (the three-call upload and the optional
    wait on `parse_status`), `scan-flow` (the scan order and the optional wait
    on `lastScan.state`).
  - `src/http/` — `client` (the CLI token exchange call and the SDK token mint
    call), `gameInstances` (lists a project's game instances), `documents` (the
    upload ticket, the presigned `PUT`, the registration, and the project
    document event stream), `contentMap` (the scan order and the content map
    event stream), `sse` (frame reading and the reconnecting watcher those two
    streams share), `errors`.
  - `src/output/` — `contract` (the `--json` shapes), `envelope`, `human`.
  - `src/config.ts` — `ARTEL_API_BASE_URL` and `ARTEL_CONSOLE_BASE_URL`.
- Dependency direction: `cli` → `run` → `commands` → {`auth`, `game`,
  `credentials`, `http`} → `config`, with no edge back. `credentials` does not
  import `http`. `http/client` takes a token string; it never resolves a
  credential itself. `output` cannot receive a `ResolvedCredential` at all: it
  takes `CredentialReport`, whose `token?: never` field makes the assignment a
  compile error. "Never print the token" is enforced by the type checker rather
  than by discipline. The same holds for the SDK token: it exists only inside
  `game/start-flow.ts` and `game/logout-flow.ts`, which pass it to the child
  process's environment (`ARTEL_SDK_TOKEN`) and nowhere else — the user only
  ever holds the CLI credential.
- External systems:
  - the orchestration server's end-user API (REST, plus Server-Sent Events for
    QA run progress, project document extraction, and content map scans).
    `insomnia-api` in the sibling repository holds its OpenAPI description.
  - object storage, reached only through a presigned URL the orchestration
    server issues. `artel doc upload` sends the file bytes straight there, so
    they never pass through the orchestration server.
  - a Unity player carrying the Artel SDK, launched as a child process
- Persistent data: the signed-in user's credentials on the local machine. No
  other state is kept between invocations.

## Commands

| Purpose | Command |
|---|---|
| Install dependencies | `npm install` |
| Run locally | `npm run build && node dist/cli.js <command>` |
| Format | `npm run format` (`prettier --write .`) |
| Lint | `npm run lint` (`eslint .`) |
| Type-check | `npm run typecheck` (`tsc -p tsconfig.json --noEmit`) |
| Unit tests | `npm test` (`vitest run`) |
| Integration tests | `npm test` — the login tests stand up real loopback HTTP servers rather than mocking `fetch`, so there is no separate suite |
| Build | `npm run build` (`tsc -p tsconfig.build.json`) |

## Constraints

- Supported platforms: Linux, macOS and Windows. The credentials file is
  `0600` on POSIX; Windows does not enforce POSIX mode bits, so there the file
  leans on the user profile ACL and `--json` reports `"mode": null`.
- Compatibility requirements: Node `>=22.12.0`, which is what `commander@15`
  requires. The `--json` shape of every command is a public contract from the
  first release; `tests/json-contract.test.ts` asserts each command's key set
  so that removing or renaming a field breaks the build.
- Performance constraints: none. Every HTTP request carries
  `AbortSignal.timeout(30_000)` and none is retried — issuing a token is not
  idempotent.
- Security or privacy requirements:
  - The token is never written to stdout, stderr, a log, or an error message.
    `--json` reports a `fingerprint` — the first 12 hex of `sha256(token)` —
    instead.
  - The credentials file is created `0600` at `open` time, not chmod'd
    afterwards, and the CLI refuses to read one that group or others can reach.
  - `artel auth login` binds its callback listener to `127.0.0.1` only,
    checks the `Host` header, and compares `state` with `timingSafeEqual`.
  - There is no `--token` flag. A secret on the process arguments is visible to
    every other user on the machine through `ps`; `ARTEL_TOKEN` fills that need.

### Server-Sent Events take the same Bearer token as everything else

The content map stream's KDoc says it is cookie-authenticated. That sentence
describes a browser: `EventSource` cannot set request headers, so the console
has nothing but the `artel_access_token` cookie to send. It is not a rule
against headers. `SecurityConfig.cookieTokenConverter` runs the standard bearer
token converter first and falls back to the cookie only when no `Authorization`
header arrived, so the CLI's token works on every stream. `tests/doc-scan.test.ts`
asserts the header reaches the stream endpoint.

The CLI does not use `EventSource` for the same reason `qa watch` does not:
Node's `EventSource` accepts no request headers and reconnects forever, which in
CI is a job that never ends.

### What the SDK imposes on a launched build

Both of these were measured against a WordVenture development build on
2026-09-03, not inferred from the code.

- **A game launched in `-batchmode` cannot be captured.** The SDK reads the back
  buffer, and batchmode presents none. With the graphics device disabled
  (`-nographics`) the capture comes back a flat grey; with a real Direct3D11
  device still present it comes back pure black. Neither raises an error and
  both encode to a valid PNG, so a silent black screenshot is the failure mode.
  A launch this CLI performs must therefore not pass `-batchmode`, and a build
  the user launches with it should be refused rather than captured.
- **The SDK attaches itself only to a development build.** `ArtelManager`
  spawns from `RuntimeInitializeOnLoadMethod` under `UNITY_EDITOR ||
  DEVELOPMENT_BUILD`, so a release build carries no SDK unless a scene places
  one. A build without it cannot be driven, and the CLI should say that rather
  than wait for a connection that will not arrive.

## Ownership

- Maintainers: TODO
- Sensitive modules: whatever comes to hold the local credentials
- Changes requiring explicit review: the shape of any `--json` output, which is
  a public contract
