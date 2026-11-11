# 2026-11-11 — CLI QA run 입력 모드 선택 추가

- Date: 2026-11-11
- Jira: ARTEL-1423
- Status: Approved

## Goal

`artel qa run --input-mode virtual|os`가 backend의 `inputMode`로 전달된다. 생략하면 필드를 보내지 않아 기본값 `virtual`을 유지한다.

## Non-goals

SDK 빌드 설정, 네이티브 입력 구현, run 도중 모드 변경은 추가하지 않는다.

## Context / Constraints

backend ARTEL-1422가 허용값과 run 동안의 고정을 담당한다. 기존 checkout의 사용자 수정은 건드리지 않는다. `qa matrix`는 병렬 OS 커서 충돌과 journal 식별자 처리를 함께 검토한다.

## Approach (Checklist)

- [x] **Step 0: Recon** — `src/run.ts`, `commands/qa/run.ts`, `http/qa.ts`의 전달 경로 확인.
- [x] **Step 1: Implementation** — run 옵션·인수 타입·요청 body에 선택값 추가.
- [x] **Step 2: Tests** — 두 허용값, 생략, 잘못된 값의 HTTP 이전 거절 확인.
- [x] **Step 3: Rollout / Rollback** — SDK와 backend 뒤에 병합하며 변경 commit을 revert하면 복구.

## Validation

- **Commands to run:** focused Vitest, `npm run typecheck`, `npm run build`.
- **Expected output:** 기본 요청에 새 필드가 없고 명시한 값만 전달된다.

## Risks & Rollback

- **Risks:** backend 지원 전 OS 모드를 실행할 수 없다. OS 권한과 포커스는 SDK가 검증한다.
- **Rollback steps:** 기능 commit revert.

## Open Questions

`qa matrix`는 이번 범위에서 OS 입력을 노출하지 않는다. 병렬 슬롯의 커서 충돌과 journal 식별자 변경을 별도 설계하기로 부모 작업에서 결정했다.

## Plan Review

FAST REVIEW: PASS — 허용값과 생략 계약 및 HTTP 이전 검증이 명확하다.

MEDIUM REVIEW: PASS — 기존 run 요청 경로만 확장한다.

HEAVY REVIEW: PASS — SDK/backend 구현에 의존하며 클라이언트에서 입력 동작을 추측하지 않는다.

Pair review: PASS — 독립 critic이 actionable finding 없이 확인했다. 관련 Vitest 47개, TypeScript typecheck와 build, 실제 help 출력, `git diff --check`를 통과했다. 실제 SDK/backend OS 입력 run은 상위 작업의 통합 검증 대상이다.
