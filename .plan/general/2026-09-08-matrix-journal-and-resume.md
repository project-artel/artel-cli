# 2026-09-08 — qa matrix 가 결과 파일에 적고 --resume 으로 이어 돌린다

- Date: 2026-09-08
- Jira: ARTEL-857
- Status: Planned
- Based on: ARTEL-856 의 branch

## Goal

런이 끝날 때마다 `--out` 파일에 한 줄씩 적고, `--resume` 이 그 파일에 있는 런을 건너뛴다.

## Context

`--json` 은 전체가 끝난 뒤 stdout 에 한 줄을 낸다. 12 런 중 7 번째에서 죽으면 이미 끝난 6 개의
판정도 함께 사라진다. 서버에는 그 런이 남아 있지만 어느 조합이 어느 런이었는지는 사라진 출력
안에만 있었다. `--repeat` 이 생기면서 한 번 도는 시간이 더 길어졌다.

## Non-goals

- CSV 출력.
- 진행 중인 런에 다시 붙는 것. `qa watch` 의 일이다.

## Decisions

### JSON Lines 다

한 줄에 하나씩 쓰면 중간에 죽어도 그때까지가 온전한 파일이다. 배열 하나로 감싸면 닫는 괄호가
없어 파일 전체가 못 읽는 것이 된다.

### 열쇠는 축 값과 반복 번호다

전개 순서 번호(`index`)는 축 목록에서 나온 값이라, `--model` 을 하나 더하면 같은 번호가 다른
설정을 가리킨다. 그러면 `--resume` 이 돌지 않은 설정을 돌았다고 읽고 건너뛴다.

### `--resume` 은 경로를 받지 않는다

읽는 파일과 쓰는 파일이 다를 수 있으면 "A 를 읽고 B 에 쓴다" 는 상태가 생기는데, 그것이 무엇을
뜻하는지 말할 수 없다. `--out` 이 곧 그 파일이고, `--resume` 만 주면 usage 오류다.

### 축이 어긋나면 게임을 띄우기 전에 멈춘다

다른 실험의 파일에 이어 쓰면 한 표에 두 실험이 섞이고, 그 표를 읽는 사람은 자기가 무엇을
비교했는지 모른다.

### 망가진 줄은 건너뛰지 않고 거절한다

건너뛰면 그 런을 돌지 않은 것으로 보고 다시 돌리는데, 서버에는 이미 있으므로 한 실험에 같은
설정의 런이 둘 생긴다.

## Implementation

- `src/qa/journal.ts` — `runKey`, `appendRun`, `readJournal`, `rejectForeignRuns`.
- `src/errors.ts` — 오류 코드 셋.
- `src/commands/qa/matrix.ts` — 시작 전 읽기, 슬롯 loop 의 건너뛰기와 append.
- `src/run.ts` — `--out`, `--resume`, `--resume` 단독 사용 거절.
- `tests/qa-matrix-journal.test.ts`, `tests/qa-matrix.test.ts`, `README.md`

## Validation

- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`
- 2 런을 적고 `--resume` 으로 다시 돌려 게임이 하나도 뜨지 않는지, 최종 payload 가 처음부터
  돈 것과 같은지, 축이 다른 파일을 거절하는지 확인한다.
