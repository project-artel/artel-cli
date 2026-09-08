# 2026-09-08 — pull request 마다 test 와 lint 와 typecheck 를 돌린다

- Date: 2026-09-08
- Jira: ARTEL-848
- Status: Planned

## Goal

`main` 으로 가는 pull request 와 `main` push 에서 `npm ci`, `npm run lint`, `npm run typecheck`,
`npm test`, `npm run build` 를 돌리는 workflow 를 둔다.

## Context

이 저장소의 workflow 는 `.github/workflows/release.yml` 하나이고 `on.push.tags` 로만 돈다. 태그를
밀 때는 네 검사를 전부 돌리지만, pull request 에서는 아무것도 돌지 않는다. 검사가 배포 순간에만
있어서, 깨진 변경은 merge 된 뒤 태그를 밀 때 처음 걸린다.

패키지는 이미 `@project-artel/cli` 로 배포되고 있다. `--json` 출력 모양은 공개 계약이고
`tests/json-contract.test.ts` 가 그것을 지키는데, 그 테스트가 PR 에서 돌지 않으면 계약을 깨는
변경이 리뷰를 그냥 통과한다.

## Non-goals

- 배포 workflow. ARTEL-804 로 이미 merge 되었고 `release.yml` 은 건드리지 않는다.
- 커버리지 측정과 그 문턱값.
- 여러 Node 버전이나 여러 OS 로 늘리는 matrix.

## Decisions

### Node 는 `release.yml` 과 같은 `22.14.0` 을 쓴다

`package.json` 의 `engines` 는 `>=22.12.0` 이고 그것은 사용자가 쓸 수 있는 바닥이다. 검사를 그
바닥에서 돌리면 배포가 도는 `22.14.0` 과 달라져, PR 이 통과한 변경이 태그에서 깨질 수 있다. 두
자리가 같은 버전을 보게 두고, 사용자 바닥을 실제로 재는 일은 별도 문제로 남긴다.

### 단계를 하나로 합치지 않는다

`npm run lint && npm run typecheck && npm test` 로 묶으면 로그에서 어느 것이 깨졌는지 찾는 데
스크롤이 든다. `release.yml` 도 네 줄로 나눠 두었으므로 같은 모양을 유지한다.

### 순서는 `release.yml` 과 같게 typecheck, lint, test, build 다

같은 검사를 두 workflow 가 다른 순서로 돌 이유가 없다. 읽는 사람이 두 파일을 대조할 때 순서가
같아야 빠진 단계가 눈에 띈다.

### 동시 실행을 취소한다

같은 pull request 에 연달아 push 하면 앞의 실행은 결과가 필요 없다. `concurrency` 로 취소해
runner 시간을 아낀다. `main` push 는 branch 별로 묶이므로 서로를 취소하지 않는다.

## Implementation

`.github/workflows/ci.yml` 하나를 새로 만든다. 다른 파일은 바뀌지 않는다.

## Validation

- 이 변경을 올린 pull request 자체에서 다섯 단계가 전부 통과하는 것으로 확인한다.
- 로컬에서 `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` 를 순서대로
  돌려 workflow 가 부르는 script 가 전부 존재하는지 먼저 본다.
