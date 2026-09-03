# Pull Request Workflow

## Why

PR should let reviewer understand intent, verify evidence, and identify risk without reconstructing development history.

## Before Opening

- Confirm issue acceptance criteria.
- Update plan to reflect final implementation.
- Review full diff against default branch.
- Remove debug code and unrelated churn.
- Run required validation.
- Confirm migrations, configuration, and rollback needs.

## Title

Use Conventional Commit format with a Korean summary:

```text
<type>(<optional-scope>): <한글 요약>
```

A title is a label for the change, not a claim about it. Name the thing that
changed and say what happened to it, and give the number when there is one.
Never write a title a reviewer has to interpret: an aphorism, a figure of
speech, or a sentence stating an insight rather than an edit cannot be checked
against the diff.

| 나쁨 | 좋음 |
| --- | --- |
| `fix(qa): 런은 agent 가 물어봐서 나아간다` | `fix(qa): QA 런에 tool 호출 상한과 벽시계 마감을 둔다` |
| `refactor: 구조를 데이터로` | `refactor(qa): loop 상한과 vision 여부를 QaArchSpec 필드로 옮긴다` |
| `feat: 지식은 두 번 모델을 거친다` | `feat(knowledge): knowledge 항목마다 검색용 질문을 생성해 색인한다` |

Write the body in Korean as well. Keep the template headings, code identifiers,
API names, CLI commands, and error strings in their original form.

## Body Template

```markdown
## Why

## What Changed

## Example

## Validation
- [ ] Command or manual check

## Risks

## Rollback

Closes #123
```

## Metadata

Set assignee, label, and milestone when creating the PR, not afterwards. An
unassigned or unlabeled PR does not appear in the boards and filters the team
uses to find work, so it stalls without anyone noticing.

- **Assignee** — whoever is responsible for landing it. Use `--assignee @me`
  when that is you.
- **Label** — at minimum the one matching the change type.
- **Milestone or project** — when the repository tracks work that way.
- **Reviewer** — request explicitly rather than relying on default rules.

```bash
gh pr create --title "<title>" --body-file /tmp/pr-body.md \
  --assignee @me --label fix --reviewer <handle>
```

Read the repository's existing labels with `gh label list` before guessing.
Creating a label that duplicates an existing one with different wording splits
the boards it was meant to feed.

## Example

A pull request that changes how data moves, or what a screen shows, carries an
`Example` section. Required for those two kinds of change; omit it for a
documentation, refactor, or configuration change that touches neither.

The point is that a reviewer can see the change happen without running it. A
diff shows what the code became; it does not show what the system now does with
a record.

**Data flow.** Follow one concrete record end to end: the input as it arrives
(wire payload, file, message), what gets written and where — name the tables,
columns, keys, or object paths — and what the next consumer reads back. Prefer
real values taken from a fixture, a test, or a local run over invented ones, and
say which they are. "It is persisted" is not an example; the row is.

**Screens.** Embed a screenshot for every state the change introduces, not just
the successful one. Capture against a running stack whenever the screen can
reach one — a screenshot of mock data proves the component renders, not that the
contract holds. Commit the images into the repository, under
`.plan/assets/<plan-name>/` where the repository keeps plans, and link them with
a `raw.githubusercontent.com` address pinned to the commit hash. A
repository-relative path does not render inside a pull request body, and an
image hosted elsewhere goes blank when that host does.

**Say what the example does not prove.** An example built from seeded rows, a
fixture, or a stubbed dependency demonstrates the shape, not the integration.
State that in the section itself. A reviewer who assumes end-to-end evidence
because none was disclaimed is a reviewer the pull request misled.

## Safe Creation

Write generated PR content to a Markdown file before invoking GitHub CLI. Pass
the file with `--body-file`; do not interpolate multiline content into `--body`.
This prevents shell quoting, command substitution, and newline damage.

Use a temporary file unless the repository requires the PR draft to be tracked:

```bash
gh pr create --title "<title>" --body-file /tmp/pr-body.md
```

After creation, read the remote PR back with `gh pr view` and confirm the title
and body match the source file. Fix the remote PR before reporting completion if
content is missing, truncated, or malformed. Remove temporary files after
successful verification.

## Review Rules

- Keep PR focused on one coherent outcome.
- Mark draft while known required work remains.
- Respond to each actionable review comment.
- Resolve threads only after change or explicit agreement.
- Add new commits during review when history clarity matters.
- Squash only when repository policy prefers a single final commit.

## Merge Criteria

- acceptance criteria satisfied
- required checks pass
- review approvals complete
- unresolved risks explicitly accepted
- deployment or migration order documented
