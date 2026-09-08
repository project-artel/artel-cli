# 2026-09-08 — README 의 명령 목록을 실제로 있는 명령과 맞춘다

- Date: 2026-09-08
- Jira: ARTEL-860
- Status: Planned
- Based on: ARTEL-847 의 branch (이 chain 의 마지막이라 앞의 결과가 모두 들어 있다)

## Goal

README 의 "What it is for" 예시 블록이 실제로 있는 명령을 담고, 없는 것을 담지 않는다.

## Context

그 블록은 `case`·`scenario`·`run`·`doc` 네 명령군이 생기기 전에 쓰였다. 이 chain 이 `project`,
`issue`, `map`, `qa list`, `qa models`, `qa labels` 를 더 얹었다. `game start` 절에는 "QA 명령은
아직 만들지 않았다" 는 문장도 남아 있었다.

## Non-goals

- README 를 다시 쓰는 것.
- 명령별 상세 문서를 따로 만드는 것.
- login 과 SDK token 서술. ARTEL-847 이 이미 고쳤다.

## Decisions

### 블록을 순서로 읽히게 둔다

명령을 알파벳순이나 그룹순이 아니라 실제로 하는 순서로 적는다 — 로그인, id 찾기, 재료 만들기,
게임 띄우기, 돌리기, 결과 읽기. 이 도구를 처음 여는 사람이 읽는 것은 목록이 아니라 절차다.

### 줄마다 그 명령이 무엇을 위한 것인지 한 마디를 붙인다

`artel qa list --project <id>` 만으로는 왜 그것이 필요한지 알 수 없다. `# find a run you lost`
가 그 자리를 메운다.

### 블록이 전부가 아니라는 것을 적는다

`artel <group> --help` 를 가리키고, 이 README 가 없는 명령을 적지 않는다고 못 박는다. 그 문장이
다음에 이 블록을 고칠 사람에게 규칙이 된다.

## Implementation

- `README.md` — "What it is for" 블록과 `game start` 절의 한 문장.

## Validation

- 블록의 모든 줄을 `node dist/cli.js <group> <sub> --help` 로 돌려 실재를 확인한다.
- flag 이름도 `--help` 와 대조한다.
