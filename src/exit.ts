/**
 * exit code 는 셋뿐이다: 0 성공, 1 실패, 2 사용법 오류. 더 세분한 값은 만들지 않는다 —
 * 기계가 원하는 구분은 `error.code` 가 이미 준다.
 *
 * `run.ts` 가 아니라 자기 모듈에 있는 이유는 명령 구현이 이 값을 읽기 때문이다. `run.ts` 는
 * 그 명령들을 import 하므로, 거기 두면 명령 → `run.ts` → 명령 의 import cycle 이 된다.
 */
export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;
