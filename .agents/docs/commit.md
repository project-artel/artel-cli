# Commit Workflow

## Why

Each commit should explain one coherent change and remain safe to review or revert independently.

## Format

Use Conventional Commits:

```text
<type>(<optional-scope>): <한글 요약>
```

Examples:

```text
feat(auth): 세션 만료 기능 추가
fix(api): 빈 업스트림 응답 처리
docs: 로컬 테스트 방법 문서화
```

Use the same types defined in [`branch.md`](branch.md).

## Rules

- Keep subject at 50 characters or fewer when practical.
- Write the summary after `<type>: ` in Korean. Leave code identifiers, API
  names, CLI commands, and error strings in their original form.
- Do not end subject with a period.
- Describe why in body when motivation is not obvious.
- Reference issue in footer when repository automation requires it.
- Do not mix unrelated behavior, formatting, and refactoring.
- Do not commit secrets, generated noise, or local-only configuration.
- Keep a line-ending renormalization in its own commit. Follow
  [`line-endings.md`](line-endings.md).

## Body

Add a body when change has non-obvious constraints or tradeoffs:

```text
fix(cache): 새로고침 중 기존 캐시 값 유지

동시에 새로고침이 겹치면 읽을 수 있던 값까지 비웠다. 교체가 성공할 때까지
이전 값을 남겨 호출부가 예측 가능한 대체 동작을 유지하게 한다.

Refs #123
```
