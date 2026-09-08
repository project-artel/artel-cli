import { resolveApiBaseUrl } from '../config.js';
import { resolveCredential } from '../credentials/resolve.js';
import { CliError } from '../errors.js';

export interface ProjectContext {
  apiBaseUrl: string;
  cliToken: string;
}

/**
 * `project` 명령이 공유하는 준비: API 주소와 자격 증명.
 *
 * `qa/context.ts` · `testRuns/context.ts` 와 같은 판단으로 별도 함수다 — 내용이 같아도
 * 도메인이 다르고, 이름이 `resolveQaContext` 인 함수를 project 명령이 부르면 읽는 사람이 두
 * 도메인이 어디선가 얽혀 있다고 오해한다.
 *
 * `resolveConfig` 가 아니라 `resolveApiBaseUrl` 만 부른다. 이 명령은 console 을 한 번도 부르지
 * 않으므로, console 주소를 말하지 않았다는 이유로 목록 조회가 막히면 그것은 이 명령이 하지 않는
 * 일 때문에 막는 것이다.
 */
export async function resolveProjectContext(
  env: NodeJS.ProcessEnv,
  apiUrl: string | undefined,
): Promise<ProjectContext> {
  // 자격증명을 먼저 읽는다. 파일에 적힌 `apiBaseUrl` 이 주소의 마지막 후보다.
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
