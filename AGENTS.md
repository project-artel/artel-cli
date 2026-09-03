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
- `.agents/docs/git-language.md`

Follow `.agents/docs/line-endings.md` when adding `.gitattributes`, normalizing
line endings, or reviewing a diff where every line changed.

This CLI is published, so follow `.agents/docs/release.md` for a release.

Use project-local skills when installed and applicable. Skill instructions
define their own triggers, formats, and output paths.

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
