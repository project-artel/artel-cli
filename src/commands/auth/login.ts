import { defaultLoginFlowDeps, runLoginFlow, type LoginFlowDeps } from '../../auth/login-flow.js';
import { resolveConfig } from '../../config.js';
import { fingerprint } from '../../credentials/resolve.js';
import { statCredentialFile, writeCredential } from '../../credentials/store.js';
import { credentialsPath } from '../../credentials/paths.js';
import { CREDENTIAL_FILE_VERSION, type StoredCredential } from '../../credentials/types.js';
import type { LoginPayload } from '../../output/contract.js';
import { writeJsonPayload, type OutputSink } from '../../output/envelope.js';
import { printLogin } from '../../output/human.js';

export interface AuthLoginOptions {
  json: boolean;
  name: string;
  /** `null` 은 만료 없음이다. */
  expiresInDays: number | null;
  /** `--api-url`. 있으면 `ARTEL_API_BASE_URL` 보다 이긴다. */
  apiUrl?: string | undefined;
  /** `--console-url`. 있으면 `ARTEL_CONSOLE_BASE_URL` 보다 이긴다. */
  consoleUrl?: string | undefined;
}

export async function runAuthLogin(
  options: AuthLoginOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
  makeDeps: (notify: (message: string) => void) => LoginFlowDeps = defaultLoginFlowDeps,
): Promise<void> {
  const config = resolveConfig(env, {
    apiBaseUrl: options.apiUrl,
    consoleBaseUrl: options.consoleUrl,
  });

  // 진행 상황은 stderr 로 간다. `--json` 을 켠 쪽의 stdout 에는 payload 한 줄만 남아야 한다.
  const notify = (message: string): void => {
    sink.err(message);
  };

  const before = await statCredentialFile(env);
  const issued = await runLoginFlow(
    {
      apiBaseUrl: config.apiBaseUrl,
      consoleBaseUrl: config.consoleBaseUrl,
      tokenName: options.name,
      expiresInDays: options.expiresInDays,
    },
    makeDeps(notify),
  );

  const credential: StoredCredential = {
    version: CREDENTIAL_FILE_VERSION,
    token: issued.token,
    tokenId: issued.id,
    tokenName: issued.name,
    createdAt: issued.createdAt,
    expiresAt: issued.expiresAt,
    apiBaseUrl: config.apiBaseUrl,
  };

  // 이미 파일이 있어도 묻지 않고 덮어쓴다. rename 이 통째로 갈아 끼우므로 반쯤 쓰인
  // 파일이 남지 않는다. 다만 덮어썼다는 사실은 출력에 적는다.
  const written = await writeCredential(credential, env);

  const payload: LoginPayload = {
    authenticated: true,
    source: 'file',
    credentialsPath: credentialsPath(env),
    mode: written.mode,
    fingerprint: fingerprint(issued.token),
    tokenId: issued.id,
    tokenName: issued.name,
    createdAt: issued.createdAt,
    expiresAt: issued.expiresAt,
    apiBaseUrl: config.apiBaseUrl,
  };

  if (options.json) {
    writeJsonPayload(sink, payload);
    return;
  }
  printLogin(sink, payload, before.exists);
}
