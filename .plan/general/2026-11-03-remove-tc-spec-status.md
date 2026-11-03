# 2026-11-03 — TC 명세 등급 status 제거

- Date: 2026-11-03
- GitHub Issue: None
- Jira: ARTEL-1324 (상위 ARTEL-1320)
- Status: Implemented

## Goal
TC 명세 등급을 DB·서버·생성·API·화면에서 제거.

## Non-goals
QA verificationStatus, content map status 및 원본 scenario quality 변경.

## Context / Constraints
기존 미커밋 변경을 보존하고 최신 main의 별도 worktree에서 이번 변경만 적용했다.

## Approach (Checklist)
- [x] **Step 0: Recon**: 전체 TC 입출력과 export 참조 확인.
- [x] **Step 1: Implementation**: TC HTTP 응답·공개 JSON 타입·텍스트 출력에서 status 제거. JSON key-set 테스트와 fixture 갱신.
- [x] **Step 2: Tests**: npm run typecheck 통과. 전체 vitest 460개 통과. 사용자 자격증명 영향을 피하기 위해 별도 ARTEL_CONFIG_DIR 사용.
- [x] **Step 3: Rollout / Rollback**: 서버·DB 계약 변경 후 소비자를 적용한다. 운영 배포는 수행하지 않는다.

## Validation
npm run typecheck 통과. 전체 vitest 460개 통과. 사용자 자격증명 영향을 피하기 위해 별도 ARTEL_CONFIG_DIR 사용.

## Risks & Rollback
TC JSON의 status가 제거되는 계약 변경이다. verificationStatus는 유지한다. 서버 변경 후 적용하며 rollback은 이 commit revert.

## Open Questions
없음. 알려진 검증 제한은 위에 기록했다.
