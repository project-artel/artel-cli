# Project Context

Fill this document during project initialization. Agents must verify commands against repository configuration before running them.

## Overview

- Product: `artel`, the command line interface for the ARTEL platform
- Primary users: customers running QA from a terminal or from CI, and coding
  agents driving the same loop. Both read the same commands; the machine reader
  is served by `--json` rather than by a separate interface.
- Core domain: authenticated access to the orchestration server's end-user API,
  and launching a game build that carries the Artel SDK
- Runtime environment: Node.js with TypeScript (not yet configured — see
  Commands below)

## Architecture

- Entry points: TODO — the `artel` binary, once `package.json` declares it
- Main modules: TODO
- Dependency direction: TODO
- External systems:
  - the orchestration server's end-user API (REST, plus Server-Sent Events for
    QA run progress). `insomnia-api` in the sibling repository holds its OpenAPI
    description.
  - a Unity player carrying the Artel SDK, launched as a child process
- Persistent data: the signed-in user's credentials on the local machine. No
  other state is kept between invocations.

## Commands

| Purpose | Command |
|---|---|
| Install dependencies | TODO |
| Run locally | TODO |
| Format | TODO |
| Lint | TODO |
| Type-check | TODO |
| Unit tests | TODO |
| Integration tests | TODO |
| Build | TODO |

## Constraints

- Supported platforms: TODO
- Compatibility requirements: TODO
- Performance constraints: TODO
- Security or privacy requirements: TODO

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
