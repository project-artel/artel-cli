import { resolveApiBaseUrl } from '../config.js';
import { resolveCredential } from '../credentials/resolve.js';
import { CliError } from '../errors.js';

export interface DocContext {
  apiBaseUrl: string;
  cliToken: string;
}

/**
 * `doc` 명령 둘이 공유하는 준비: API 주소와 자격 증명.
 *
 * `qa/context.ts` · `scenario/context.ts` 와 같은 이유로 `resolveConfig` 가 아니라
 * `resolveApiBaseUrl` 만 부른다 — `doc` 명령은 console 을 한 번도 부르지 않으므로, console
 * 주소를 말하지 않았다는 이유로 업로드가 막히면 그것은 이 명령이 하지 않는 일 때문에 막는 것이다.
 */
export async function resolveDocContext(
  env: NodeJS.ProcessEnv,
  apiUrl: string | undefined,
): Promise<DocContext> {
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
