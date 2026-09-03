# Issue Workflow

## Why

An issue defines the problem and acceptance boundary. It should not prescribe implementation before investigation.

## Ready Criteria

An issue is ready when it has:
- clear problem statement
- user or system impact
- acceptance criteria
- known constraints
- explicit non-goals when scope could expand
- dependencies or blockers

## Issue Template

```markdown
## Problem

## Impact

## Acceptance Criteria
- [ ]

## Constraints

## Non-goals

## Validation Notes
```

## Metadata

Set assignee, label, and milestone when creating the issue, not afterwards. An
unassigned or unlabeled issue does not appear in the boards and filters the team
uses to plan work, so it sits unseen.

- **Assignee** — whoever owns the problem. Leave unset only when the issue is
  deliberately open for pickup.
- **Label** — at minimum the one matching the work type.
- **Milestone or project** — when the repository tracks work that way.

```bash
gh issue create --title "<title>" --body-file /tmp/issue-body.md \
  --assignee @me --label fix --milestone "<name>"
```

Read the repository's existing labels with `gh label list` before guessing.
Creating a label that duplicates an existing one with different wording splits
the boards it was meant to feed.

## Title

An issue title names the problem or the change, not a thesis about it. The same
rule as a pull request title: name the thing, say what happens to it, give the
number, and never write a title a reader has to interpret.

- An Epic names the outcome — `QA 런 결과를 재생할 수 있게 한다`
- A Story names the behavior that changes — `pulse 를 QA agent 문맥에 싣는다`
- A repository issue names what that repository does about it —
  `pulse 프레임을 SceneMemory 에 누적한다`

An aphorism, a figure of speech, or a rhetorical question is not a title. If it
reads like a slide headline rather than a work item, rewrite it.

## Language

Write the title and body in Korean. Keep code identifiers, API names, CLI
commands, and error strings in their original form.

## Safe Creation

Write generated issue content to a Markdown file before invoking GitHub CLI.
Pass the file with `--body-file`; do not interpolate multiline content into
`--body`. This prevents shell quoting, command substitution, and newline damage.

Use a temporary file unless the repository requires the issue draft to be
tracked:

```bash
gh issue create --title "<title>" --body-file /tmp/issue-body.md
```

After creation, read the remote issue back with `gh issue view` and confirm the
title and body match the source file. Fix the remote issue before continuing if
content is missing, truncated, or malformed. Remove temporary files after
successful verification.

## Lifecycle

1. Create or refine issue.
2. Confirm dependencies and priority.
3. Mark in progress only when active work starts.
4. Link branch, plan, and PR.
5. Update scope changes in issue before implementing them.
6. Close only after acceptance criteria and required validation pass.

## Sizing

Split issue when it contains multiple independently releasable outcomes or requires unrelated ownership areas.

Do not split tightly coupled steps that cannot provide value or validation independently.
