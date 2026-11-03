# 2026-11-03 — CLI·MCP TC 검토 상태 추가

- Date: 2026-11-03
- Jira: ARTEL-1316 (server ARTEL-1317, CLI ARTEL-1318, MCP ARTEL-1319)
- Status: Draft

## Goal
TC 검토 상태 reviewStatus(DRAFT/READY)를 status 및 verificationStatus와 별도로 저장한다. CLI·MCP에서 신규 생성 기본은 draft이며 명시적으로 해제하면 READY다.

## Non-goals
UI 변경과 배포, 기존 TC 검토 상태 초기화는 포함하지 않는다.

## Context / Constraints
기존 TC와 화면·지도 생성은 READY로 유지한다. 서버 create 요청 draft는 생략하면 false(기존 호환), CLI·MCP는 true를 명시한다. MCP batch draft 기본 true는 신규 TC에만 적용하고 수정 시 기존 검토 상태를 보존한다. draft false는 검증 통과를 뜻하지 않는다.

## Approach (Checklist)
- [x] **Step 0: Recon** 최신 서버 #393, MCP #10 위에 쌓고 CLI main을 사용한다. 기존 작업 checkout을 건드리지 않는다.
- [ ] **Step 1: Implementation** test_case.review_status NOT NULL DEFAULT READY 및 CHECK, create draft boolean, update reviewStatus 검증. 응답·목록·버전·계약 목록에서 상태 반환. CLI create --draft/--no-draft(기본 true), update JSON reviewStatus 승인 지원. MCP save_test_cases draft=true와 preview 값 보존, 상태 표시 및 검토 상태 변경 도구.
- [ ] **Step 2: Tests** 기본·명시 false 생성, 기존 데이터 호환, 업데이트 승인, boolean 유효성, batch·preview 보존. 서버에서 draft를 저작 후보·검색·커버리지에서 제외하고 수동 참조 및 QA 실행에 포함된 draft를 거절한다. 상태는 TC identity 단위다.
- [ ] **Step 3: Rollout / Rollback** 서버 migration/API 먼저, CLI·MCP 다음. draft PR만 생성. API 미배포 시 클라이언트가 조용히 READY TC를 생성하지 않도록 생성 전 GET /api/projects/{projectId}/test-cases/review-status-options 로 지원 확인({statuses:[DRAFT,READY]}). 미지원이면 POST 전에 실패. CLI JSON draft는 거절하며 명령 flag가 배치 전체를 정한다. 모든 수정·재생성은 명시적 검토 상태 변경 외에는 기존 검토 상태를 유지.

## Validation
- **Commands to run:** CLI npm test/typecheck/lint/build; MCP uv run pytest/ruff; 서버 mvnw focused integration + OpenAPI snapshot.
- **Expected output:** 초안이 저장·조회되지만 승인 전 저작·QA 사용 불가, READY+verificationStatus DRAFT는 정상 사용 가능.

## Risks & Rollback
- **Risks:** 사용 후보 조회·수동 참조 누락, MCP preview 옵션 유실, 구서버가 새 필드 무시. 기존 기록 조회는 유지한다.
- **Rollback steps:** 클라이언트부터 revert, 서버 revert 후 review_status 컬럼은 무시하거나 삭제한다.

## Open Questions
없음. 검토 상태는 생성 시와 명시적 변경에서만 바뀐다.

## Plan Review
FAST NONPASS: 생성 후 검출을 생성 전 지원 조회로 변경하고 flag 우선순위와 각 경로 기본값 테스트를 명시했다. MEDIUM PASS: 서버가 후보 제외를 소유한다.

## CLI 구현 및 검증

- CLI 구현 완료. `case create` 기본은 draft이며 `--draft` / `--no-draft`를 단건·배열 전체에 적용한다.
- JSON 본문에 `draft` 또는 `reviewStatus`가 있으면 생성 전에 거절한다.
- 생성과 명시적 검토 상태 변경 전에 `review-status-options`를 조회한다. 생성·승인 응답의 상태가 요청과 다르면 재시도 전에 저장 결과를 확인하도록 알린다.
- 일반 수정은 검토 상태를 유지하고 `case update`의 `reviewStatus: READY`는 승인한다. legacy 조회 응답의 없는 상태는 READY로 읽는다.
- `npm test`: 40 files passed, 4 skipped; 417 passed, 61 skipped. 기존 opt-in 테스트는 실행하지 않았다.
- `npm run typecheck`, `npm run lint`, `npm run build`, `git diff --check` 통과.
- 서버 API 배포 후 이 CLI를 반영한다. 실제 배포 서버로 생성하지 않았고 저장된 TC 데이터는 변경하지 않았다.
