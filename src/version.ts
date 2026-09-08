import fs from 'node:fs';

/**
 * 이 CLI 의 버전. 근거는 `package.json` 하나다.
 *
 * 소스에 문자열로 한 번 더 적지 않는다. `release.yml` 이 태그와 `package.json` 을 대조해
 * 어긋나면 배포를 멈추는 것도 그 파일을 유일한 근거로 두었기 때문이고, 여기서 두 번째 사본을
 * 만들면 그 대조가 지키는 것이 반쪽이 된다.
 *
 * `process.cwd()` 가 아니라 `import.meta.url` 기준으로 읽는다. 사용자가 어느 디렉터리에서
 * 부르는지는 이 값과 무관한데, cwd 로 읽으면 마침 거기 있던 남의 `package.json` 을 자기 버전으로
 * 말하게 된다.
 *
 * `tsconfig.build.json` 의 `rootDir` 이 `src` 이고 `outDir` 이 `dist` 라, 이 파일은
 * `dist/version.js` 가 된다. 소스에서든 빌드 산출물에서든 `../package.json` 이 패키지 root 다.
 * `files` 가 `dist` 만 담고 있어도 npm 은 `package.json` 을 항상 함께 올리므로 설치본에서도 읽힌다.
 */
let cached: string | null | undefined;

/**
 * 읽지 못하면 `null` 이다. 버전 한 줄을 못 읽었다고 모든 명령이 죽는 것은 과하고, 반대로 못 읽은
 * 자리에 그럴듯한 숫자를 지어내면 그 값을 붙여 올린 버그 보고가 거짓을 담는다.
 */
export function readCliVersion(): string | null {
  if (cached !== undefined) {
    return cached;
  }

  try {
    const manifestPath = new URL('../package.json', import.meta.url);
    const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const version =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { version?: unknown }).version
        : undefined;
    cached = typeof version === 'string' && version.length > 0 ? version : null;
  } catch {
    cached = null;
  }

  return cached;
}

/** `--version` 이 내는 문자열. 모르는 것을 숫자로 꾸미지 않는다. */
export const UNKNOWN_VERSION = 'unknown';

export function cliVersionForDisplay(): string {
  return readCliVersion() ?? UNKNOWN_VERSION;
}
