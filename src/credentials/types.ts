export type CredentialSource = 'env' | 'file';

/** `ARTEL_TOKEN` 이 어떤 상태였는지. 셋뿐인 닫힌 집합이고 `--json` 계약이다. */
export type EnvVarState = 'used' | 'empty' | 'unset';

export const CREDENTIAL_FILE_VERSION = 1;

/** `~/.artel/credentials.json` 의 내용. */
export interface StoredCredential {
  version: number;
  token: string;
  tokenId: string;
  tokenName: string;
  createdAt: string;
  expiresAt: string | null;
  apiBaseUrl: string;
}

/** 실제로 요청에 실릴 자격 증명. `token` 을 들고 있는 유일한 타입 중 하나다. */
export interface ResolvedCredential {
  token: string;
  source: CredentialSource;
  /** source 가 `env` 면 파일을 읽지 않았으므로 `null` 이다. */
  stored: StoredCredential | null;
}

/**
 * 출력 계층이 받을 수 있는 유일한 자격 증명 표현.
 *
 * `token?: never` 는 장식이 아니다. 이것 때문에 `ResolvedCredential`(`token: string`)
 * 이 `CredentialReport` 에 대입되지 않고, 그래서 `output/*` 로 token 을 흘리는 코드는
 * 규율이 아니라 컴파일 오류로 막힌다.
 */
export interface CredentialReport {
  token?: never;
  authenticated: boolean;
  source: CredentialSource | null;
  /** `sha256(token)` 의 앞 12 hex. token 이 아니고 되돌릴 수도 없다. */
  fingerprint: string | null;
  credentialsPath: string;
  credentialsFileExists: boolean;
  /** POSIX 는 `"0600"` 같은 4자리 8진수, Windows 는 `null`. */
  mode: string | null;
  tokenId: string | null;
  tokenName: string | null;
  createdAt: string | null;
  expiresAt: string | null;
  apiBaseUrl: string | null;
}
