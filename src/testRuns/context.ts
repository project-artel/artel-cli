import { resolveApiBaseUrl } from '../config.js';
import { resolveCredential } from '../credentials/resolve.js';
import { CliError } from '../errors.js';

export interface TestRunContext {
  apiBaseUrl: string;
  cliToken: string;
}

/**
 * `run` 명령들이 공유하는 준비: API 주소와 자격 증명.
 *
 * `qa/context.ts` 의 `resolveQaContext` 와 내용이 같다. 그래도 별도 함수로 두는 이유는,
 * `qa` 는 QA 실행을 다루고 이 그룹은 test run(자료)을 다루는 서로 다른 도메인이라서다 —
 * 이름이 `resolveQaContext` 인 함수를 test run 명령이 부르면, 읽는 사람이 두 도메인이
 * 어디선가 얽혀 있다고 오해한다. `--console-url` 을 받아만 두고 쓰지 않는 이유도 같다:
 * 이 그룹도 console 을 부르지 않는다.
 */
export async function resolveTestRunContext(
  env: NodeJS.ProcessEnv,
  apiUrl: string | undefined,
): Promise<TestRunContext> {
  // 자격증명을 먼저 읽는다. 파일에 적힌 `apiBaseUrl` 이 주소의 마지막 후보라 순서가 이렇게
  // 될 수밖에 없고, 그래서 "로그인도 안 했고 주소도 없는" 경우의 오류가
  // `missing_api_base_url` 이 아니라 `no_credential` 이 된다. 둘 다 참이고, 고치는 방법이
  // 하나뿐인 쪽을 말한다 — `artel auth login` 한 번이 자격증명과 주소를 함께 채운다.
  const resolution = await resolveCredential(env);
  if (resolution.credential === null) {
    throw new CliError(
      'no_credential',
      'Not signed in. Run "artel auth login" first, or set ARTEL_TOKEN.',
    );
  }
  const apiBaseUrl = resolveApiBaseUrl(
    env,
    apiUrl,
    resolution.credential.stored?.apiBaseUrl ?? null,
  );
  return { apiBaseUrl, cliToken: resolution.credential.token };
}
