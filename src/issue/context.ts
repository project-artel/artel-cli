import { resolveApiBaseUrl } from '../config.js';
import { resolveCredential } from '../credentials/resolve.js';
import { CliError } from '../errors.js';

export interface IssueContext {
  apiBaseUrl: string;
  cliToken: string;
}

/**
 * `issue` 명령이 공유하는 준비: API 주소와 자격 증명.
 *
 * `qa/context.ts` · `testRuns/context.ts` 와 같은 판단으로 별도 함수다 — 내용이 같아도 도메인이
 * 다르고, 이름이 `resolveQaContext` 인 함수를 issue 명령이 부르면 읽는 사람이 두 도메인이
 * 얽혀 있다고 오해한다. 이 명령군도 console 을 부르지 않으므로 `resolveApiBaseUrl` 만 쓴다.
 */
export async function resolveIssueContext(
  env: NodeJS.ProcessEnv,
  apiUrl: string | undefined,
): Promise<IssueContext> {
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
