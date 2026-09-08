# 2026-09-08 — artel qa models 와 artel qa labels 로 축 값을 확인한다

- Date: 2026-09-08
- Jira: ARTEL-853
- Status: Planned
- Based on: ARTEL-852 의 branch

## Goal

`--model`, `--reasoning-effort`, `--label` 에 무엇을 넣을 수 있는지 CLI 로 본다.

## Context

`--content-map-mode` 와 `--knowledge-mode` 는 CLI 가 값 목록을 알고 있어 즉시 거절하는데,
`--model` 만 아무 문자열이나 받는다. `qa matrix` 안에서는 그 오타가 조합 하나가 실패한 뒤에
드러나고, 여덟 조합을 걸어 두고 자리를 뜬 사람은 전부 같은 오타로 실패한 것을 나중에 본다.

서버에 `GET /api/qa-models` 와 `GET /api/qa-stats/labels` 가 있다. 앞의 것은 model 마다
`reasoning.efforts` 를 함께 낸다.

## Non-goals

- model 을 추가하거나 지우는 것.
- shell completion.

## Decisions

### CLI 가 `--model` 을 미리 검증하지 않는다

런을 걸 때마다 목록을 받아 오면 서버 왕복이 하나 늘고, 서버가 아는 목록은 CLI 배포보다 자주
바뀐다. CLI 가 든 사본이 낡으면 실제로 되는 model 을 CLI 가 거절하게 된다 — 그것은 오타를
늦게 아는 것보다 나쁘다.

### 실패 메시지에 안내를 붙이지 않는다

이슈에는 그렇게 적었지만, 확인해 보니 서버에 model 을 검증하는 오류 코드가 없다.
`QaModelCatalogService` 는 목록만 내고, 잘못된 이름은 run 생성 시점이 아니라 그 뒤 agent 쪽에서
드러난다. 짚을 코드가 없는데 일반 400 에 안내를 붙이면 원인이 다른 실패에 엉뚱한 안내가 달린다.
대신 `--model` 과 `--reasoning-effort` 의 `--help` 가 `artel qa models` 를 가리킨다.

### effort 를 model 과 같은 줄에 낸다

`--reasoning-effort` 가 받는 값은 model 마다 다르다. 두 축을 따로 고르면 서로 맞지 않는 조합을
적게 된다.

### `qa labels` 의 범위를 출력이 말한다

서버는 `projectId` 없이도 답하고, 그때 목록은 볼 수 있는 전 프로젝트의 것이다. 그 범위를
말하지 않으면 다른 프로젝트의 실험 이름을 자기 프로젝트의 것으로 읽는다.

### 능력 서술은 못 읽어도 오류가 아니다

`reasoning` 의 모양이 기대와 다르면 `null` 이다. 이 값을 못 읽었다고 목록 전체를 실패로 돌리면,
model 이름을 확인하러 온 사람이 이름조차 못 본다.

## Implementation

- `src/http/qa.ts` — `listQaModels`, `listQaLabels`, `QaModel` 과 파싱.
- `src/commands/qa/catalog.ts`
- `src/output/contract.ts`, `src/output/envelope.ts`
- `src/run.ts` — 두 명령과 `--model`·`--reasoning-effort` 도움말.
- `tests/qa-catalog-helpers.ts`, `tests/qa-catalog.test.ts`, `tests/json-contract.test.ts`

## Validation

- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`
- 가짜 서버로 두 명령을 빌드 산출물에서 확인한다. 그 fake 는 서버가 실제로 내보내는 camelCase
  모양을 쓴다 — DTO 의 `@JsonAlias("min_tokens")` 는 읽을 때만 듣는다.
