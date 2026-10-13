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
  // 자격증명을 먼저 읽는다. 파일에 적힌 `apiBaseUrl` 이 환경 변수 다음, 기본값 앞의 후보라
  // 주소를 정하기 전에 파일이 필요하다.
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
