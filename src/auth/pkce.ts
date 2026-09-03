import crypto from 'node:crypto';

export type RandomBytes = (size: number) => Buffer;

/**
 * 랜덤 32바이트를 base64url 로 적으면 43자다. 서버의
 * `SdkTokenRequest.codeVerifier` 는 `@Size(min = 43, max = 128)` 이므로 그 하한에 정확히 닿는다.
 */
export function createCodeVerifier(randomBytes: RandomBytes = crypto.randomBytes): string {
  return randomBytes(32).toString('base64url');
}

/**
 * `base64url(SHA-256(verifier))`. 서버의 `SdkLoginCodeStore` 가 S256 하나로 고정되어 있어
 * method 를 파라미터로 보내지 않는다.
 */
export function codeChallengeFor(verifier: string): string {
  return crypto.createHash('sha256').update(verifier, 'utf8').digest('base64url');
}

/** 브라우저를 지나가는 왕복 하나를 묶는 값. 랜덤 32바이트 base64url. */
export function createState(randomBytes: RandomBytes = crypto.randomBytes): string {
  return randomBytes(32).toString('base64url');
}

/** 길이가 같을 때만 `timingSafeEqual` 로 비교한다. */
export function statesMatch(expected: string, actual: string | null): boolean {
  if (actual === null) {
    return false;
  }
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}
