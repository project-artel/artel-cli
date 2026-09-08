import { resolveApiBaseUrl } from '../config.js';
import { resolveCredential } from '../credentials/resolve.js';
import { CliError } from '../errors.js';

export interface GameContext {
  apiBaseUrl: string;
  cliToken: string;
}

/**
 * 게임을 띄우지 않는 `game` 명령이 쓰는 준비: API 주소와 자격 증명.
 *
 * `game start` 와 `game logout` 은 이것을 쓰지 않는다. 그 둘은 빌드에 `-artel-frontend` 를
 * 넘겨야 해서 console 주소까지 필요하고, 그래서 `resolveConfig` 를 직접 부른다. `game list` 는
 * 서버에 물어보기만 하므로 console 주소를 요구하면 이 명령이 하지 않는 일 때문에 막는 것이 된다.
 */
export async function resolveGameContext(
  env: NodeJS.ProcessEnv,
  apiUrl: string | undefined,
): Promise<GameContext> {
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
