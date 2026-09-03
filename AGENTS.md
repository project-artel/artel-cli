# Project Agent Instructions

## Scope and Precedence

This file is the repository-level entrypoint for coding agents.

Read `.agents/docs/project.md` before non-trivial
work. Repository-specific commands, constraints, and narrower instructions take
precedence over these template defaults.

## Project Workflow

For non-trivial work, follow:

- `.agents/docs/workflow.md`
- `.agents/docs/testing.md`

Coding conventions:

- `.agents/docs/coding-style.md`

For tracked Git work, follow:

- `.agents/docs/issue.md`
- `.agents/docs/branch.md`
- `.agents/docs/commit.md`
- `.agents/docs/pull-request.md`

Follow `.agents/docs/line-endings.md` when adding `.gitattributes`, normalizing
line endings, or reviewing a diff where every line changed.

This CLI is published, so follow `.agents/docs/release.md` for a release.

Use project-local skills when installed and applicable. Skill instructions
define their own triggers, formats, and output paths.

## A token while the login command does not exist yet

`artel auth login` is the shape this repository is being built toward, not
something that runs today. Until it does, any command that calls the
orchestration server needs a token from somewhere. Against a local server, mint
it:

```bash
TOKEN=$(.claude/skills/artel-jwt/mint-jwt.py --sub <app_user.id> --ttl 8h)
```

`--sub` must be an existing `app_user.id` — the token is authoritative about
identity only, and the profile is read from the database. `/api/sdk/**` takes a
different audience (`--audience sdk`) and rejects the browser session token.

The `artel-jwt` skill covers the rest. It mints for a local server only.

## Documentation language

Write and maintain all project documentation in English. Keep code identifiers,
design tokens, API names, and technical terminology in their canonical English
form.

## Terminology in comments, documents, and pull requests

Keep a technical term in English, in backticks, even in the middle of a Korean
sentence: `pulse`, `screen`, `capability`, `anchor`, `branch`, `fold`,
`discriminator`, `evidence`, `wiring`.

Do not invent a Korean substitute for something the code already names. `판독`
for `pulse`, `갈래` for `branch`, `배선` for `wiring`, `판별자` for
`discriminator`, `근거 문서` for an `evidence` document — none of these.

This is not a push toward more English or more Korean. Prose stays whatever
reads naturally. The rule is narrower than that: a thing the code names keeps
the name the code gave it.

## What this CLI is answerable to

Two audiences read the same output: a person at a terminal and a program. Every
command that reports a result carries `--json`, and the shape of that JSON is a
contract — changing it is a breaking change even when the human-readable output
is untouched.

The CLI talks to the orchestration server's end-user API and launches a game
build that carries the Artel SDK. It owns neither. When either one imposes a
constraint, the CLI's job is to state it plainly rather than to work around it
silently.
