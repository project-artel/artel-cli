import { resolveApiBaseUrl } from '../config.js';
import { resolveCredential } from '../credentials/resolve.js';
import { CliError } from '../errors.js';

export interface QaContext {
  apiBaseUrl: string;
  cliToken: string;
}

/**
 * QA 명령 넷이 공유하는 준비: API 주소와 자격 증명.
 *
 * `resolveConfig` 가 아니라 `resolveApiBaseUrl` 만 부른다. QA 명령은 console 을 한 번도
 * 부르지 않으므로, console 주소를 말하지 않았다는 이유로 `qa show` 가 실패하면 그것은
 * 이 명령이 하지 않는 일 때문에 막는 것이다. `--console-url` 은 다른 명령들과 같은 짝을
 * 그대로 넘겨 쓸 수 있게 받아만 두고 쓰지 않는다.
 */
export async function resolveQaContext(
  env: NodeJS.ProcessEnv,
  apiUrl: string | undefined,
): Promise<QaContext> {
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
