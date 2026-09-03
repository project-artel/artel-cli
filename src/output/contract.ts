import type { ErrorCode } from '../errors.js';

/**
 * `--json` 출력의 모양. 첫 릴리스부터 공개 계약이다.
 *
 * 키는 사라지지 않는다 — 모르는 값은 `null` 이다. 키를 지우거나 이름을 바꾸는 것이
 * breaking change 다. 어느 payload 에도 `token` 필드는 없다: `--json` 출력은 CI 로그로
 * 곧장 흘러 들어가고, token 이 필요한 프로그램은 `credentialsPath` 를 읽으면 된다.
 */

export interface LoginPayload {
  authenticated: boolean;
  source: 'file';
  credentialsPath: string;
  mode: string | null;
  fingerprint: string;
  tokenId: string;
  tokenName: string;
  createdAt: string;
  expiresAt: string | null;
  apiBaseUrl: string;
}

export interface StatusPayload {
  authenticated: boolean;
  source: 'env' | 'file' | null;
  envVarState: 'used' | 'empty' | 'unset';
  credentialsPath: string;
  credentialsFileExists: boolean;
  mode: string | null;
  fingerprint: string | null;
  tokenId: string | null;
  tokenName: string | null;
  expiresAt: string | null;
  apiBaseUrl: string | null;
}

export interface LogoutPayload {
  removed: boolean;
  credentialsPath: string;
  tokenId: string | null;
  /**
   * 언제나 `false`. 이 CLI 의 `logout` 은 로컬 파일만 지운다. 계정을 바꾸려고 logout 한
   * 사람의 다른 머신 token 까지 죽이는 것은 놀라운 동작이라 서버에 `DELETE` 를 보내지
   * 않는다. 이 필드가 그 사실을 기계가 읽을 수 있게 적은 것이다.
   */
  serverSideRevoked: false;
}

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
  };
}
