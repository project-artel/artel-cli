# CLI PR 3개 통합 기록

2026-10-28에 `dev-yunseong`이 작성한 PR #45, #46, #47을 `main` 기준의
`codex/pr-bundle-20261028`에 순서대로 merge했다. 원본 branch와 commit은 유지하며,
통합 과정에서 제품 코드는 추가로 수정하지 않았다.

## 원본 PR과 보존한 변경

| 원본 PR | 고정한 source SHA | 변경 |
| --- | --- | --- |
| [#45](https://github.com/project-artel/artel-cli/pull/45) | `057b708ceb0e61e8033301e575105ed1dae6e7d6` | `map show`의 numeric content map ID 처리 수정 |
| [#46](https://github.com/project-artel/artel-cli/pull/46) | `f16e094daab37d6df0d9dd223889029e1f1b18e2` | `case create` 필수 필드 안내와 파일 전체 검증 추가 |
| [#47](https://github.com/project-artel/artel-cli/pull/47) | `adc7555498bd014dfbf7457d3c1a2daee3736a71` | WSL에서 Windows build를 실행할 때 `-logFile` 경로 변환 및 파일 누락 이유 보고 |

원본 PR의 설명, 검증 기록과 첨부 자료는 위 링크에서 확인한다. 새로운 기록으로
원본 자료를 대체하지 않는다. 세 source SHA가 통합 HEAD의 ancestor인지 검증했다.
다른 작성자의 추가 prerequisite PR은 포함하지 않았다.

## Merge 기준과 테스트 격리 수정

기준 `main`은 `1aeb793974b1d4e14722fb445ce72b5e6a73f58b`이다.
세 PR 모두 충돌 없이 merge했으며 source commit과 merge commit을 보존했다.

전체 테스트 중 기존 `doc upload`의 무자격증명 테스트가 실제 사용자 자격증명을
읽는 문제가 확인됐다. 테스트가 주입하던 `HOME`과 `USERPROFILE` 대신
`credentialsDir()`이 지원하는 `ARTEL_CONFIG_DIR`을 임시 디렉터리로 지정했다.
자격증명 해석과 CLI의 실제 동작은 변경하지 않았다.

## 검증 결과

- `npm test`: 460개 통과.
- `npm run typecheck`: 통과.
- `npm run build`: 통과.
- `npm run lint`: 통과.
- `git diff --check`: 통과.
- 원본 PR 3개의 source SHA ancestor 검증: 통과.

실제 게임 실행이나 실행 중인 ARTEL stack을 이용한 수동 검증은 수행하지 않았다.
원본 worktree와 실행 중인 프로세스는 변경하지 않았다. 이 기록을 작성한 시점에는
새 PR 생성, 원본 PR 종료, push를 수행하지 않았다.
