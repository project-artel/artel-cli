import { resolveApiBaseUrl } from '../config.js';
import { resolveCredential } from '../credentials/resolve.js';
import { CliError } from '../errors.js';

export interface ScenarioContext {
  apiBaseUrl: string;
  cliToken: string;
}

/**
 * `scenario` 명령들이 공유하는 준비: API 주소와 자격 증명. `qa/context.ts` 와 같은 이유로
 * `resolveConfig` 가 아니라 `resolveApiBaseUrl` 만 부른다 — `scenario` 명령도 console 을
 * 한 번도 부르지 않는다.
 */
export async function resolveScenarioContext(
  env: NodeJS.ProcessEnv,
  apiUrl: string | undefined,
): Promise<ScenarioContext> {
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
