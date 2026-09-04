import { resolveApiBaseUrl } from '../config.js';
import { resolveCredential } from '../credentials/resolve.js';
import { CliError } from '../errors.js';

export interface CaseContext {
  apiBaseUrl: string;
  cliToken: string;
}

/**
 * `case` 명령 다섯 개가 공유하는 준비: API 주소와 자격 증명.
 *
 * `resolveQaContext`(`qa/context.ts`)와 같은 판단이다 — `case` 명령도 console 을 부르지
 * 않으므로 `resolveConfig` 대신 `resolveApiBaseUrl` 만 부른다. `--console-url` 을 받는
 * 명령이 아니라 이 값을 threading 할 자리가 없다.
 */
export async function resolveCaseContext(
  env: NodeJS.ProcessEnv,
  apiUrl: string | undefined,
): Promise<CaseContext> {
  const apiBaseUrl = resolveApiBaseUrl(env, apiUrl);
  const resolution = await resolveCredential(env);
  if (resolution.credential === null) {
    throw new CliError(
      'no_credential',
      'Not signed in. Run "artel auth login" first, or set ARTEL_TOKEN.',
    );
  }
  return { apiBaseUrl, cliToken: resolution.credential.token };
}
