# Branch Workflow

## Why

Predictable branch names expose intent and issue linkage without relying on local context.

## Naming

```text
<작업 유형>/<issue summary with spaces replaced by hyphens>-<ISSUE KEY>
```

Examples:

```text
feat/qa-실행-설정-집계-ARTEL-244
fix/세션-만료-리다이렉트-ARTEL-251
docs/에이전트-문서-정리-ARTEL-262
```

The prefix comes from the 작업 유형 field on the Jira issue: `feat`, `fix`,
`chore`, `docs`, `refactor`, or `infra`. Korean characters stay as they appear
in the issue summary.

Issue key rules:
- exactly one Jira issue key per branch, at the end of the name
- the issue must exist before the branch does; the key is what ties commits and
  the PR back to it
- moving the issue to 진행 중 creates the branch automatically in repositories
  wired for it, as described in `workflow.md`. Confirm the branch appeared, and
  create it by hand with the same name when it did not.

## Lifecycle

- Branch from `origin/main`, this repository's default branch. There is no
  `develop` branch here.
- Keep one primary issue per branch.
- Sync with the default branch before final validation when divergence matters.
- Never force-push a shared branch without coordination.
- Delete branch after merge when no follow-up work depends on it.
