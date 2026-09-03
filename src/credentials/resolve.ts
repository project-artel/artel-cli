import crypto from 'node:crypto';

import { credentialsPath } from './paths.js';
import { readCredential, statCredentialFile, type CredentialFileStat } from './store.js';
import type {
  CredentialReport,
  EnvVarState,
  ResolvedCredential,
  StoredCredential,
} from './types.js';

export interface CredentialResolution {
  credential: ResolvedCredential | null;
  envVarState: EnvVarState;
  credentialsPath: string;
  file: CredentialFileStat;
}

/**
 * `sha256(token)` 의 앞 12 hex. token 이 아니고 되돌릴 수도 없지만, 머신 두 대를
 * 구별하고 콘솔의 어느 row 인지 짚는 데는 충분하다.
 */
export function fingerprint(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 12);
}

/**
 * 1. `ARTEL_TOKEN` 이 있고 trim 후 비어 있지 않으면 그것.
 * 2. 아니면 credentials 파일.
 * 3. 아니면 없음.
 *
 * `ARTEL_TOKEN` 이 빈 문자열이거나 공백뿐이면 없는 것으로 보고 다음으로 넘어간다.
 * secret 이 없는 CI job 은 변수를 빈 문자열로 export 하고, 거기서 모든 명령이 죽는 것보다
 * "설정 안 됨" 으로 읽는 쪽이 덜 놀랍다. 다만 조용히 넘기지 않고 `envVarState` 로 보고한다.
 */
export async function resolveCredential(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CredentialResolution> {
  const path = credentialsPath(env);
  const raw = env.ARTEL_TOKEN;
  const envVarState = classifyEnvVar(raw);

  if (envVarState === 'used') {
    // env 가 이기면 파일은 읽지 않는다. 권한이 망가진 파일 하나가 CI 를 멈추면 안 된다.
    const file = await statCredentialFile(env);
    return {
      credential: { token: (raw ?? '').trim(), source: 'env', stored: null },
      envVarState,
      credentialsPath: path,
      file,
    };
  }

  const stored = await readCredential(env);
  if (stored === null) {
    return {
      credential: null,
      envVarState,
      credentialsPath: path,
      file: { exists: false, mode: null },
    };
  }

  const file = await statCredentialFile(env);
  return {
    credential: { token: stored.token, source: 'file', stored },
    envVarState,
    credentialsPath: path,
    file,
  };
}

function classifyEnvVar(raw: string | undefined): EnvVarState {
  if (raw === undefined) {
    return 'unset';
  }
  return raw.trim().length === 0 ? 'empty' : 'used';
}

/**
 * `ResolvedCredential` 을 token 이 구조적으로 없는 타입으로 좁히는 유일한 지점.
 * 출력 계층은 이 함수의 결과만 본다.
 */
export function reportOf(resolution: CredentialResolution): CredentialReport {
  const credential = resolution.credential;
  const stored = credential?.stored ?? null;
  return {
    authenticated: credential !== null,
    source: credential?.source ?? null,
    fingerprint: credential === null ? null : fingerprint(credential.token),
    credentialsPath: resolution.credentialsPath,
    credentialsFileExists: resolution.file.exists,
    mode: resolution.file.mode,
    ...storedFields(stored),
  };
}

/**
 * source 가 `env` 면 이 넷은 전부 `null` 이다. 환경 변수는 그 값을 들고 있지 않다.
 */
function storedFields(
  stored: StoredCredential | null,
): Pick<CredentialReport, 'tokenId' | 'tokenName' | 'createdAt' | 'expiresAt' | 'apiBaseUrl'> {
  return {
    tokenId: stored?.tokenId ?? null,
    tokenName: stored?.tokenName ?? null,
    createdAt: stored?.createdAt ?? null,
    expiresAt: stored?.expiresAt ?? null,
    apiBaseUrl: stored?.apiBaseUrl ?? null,
  };
}
