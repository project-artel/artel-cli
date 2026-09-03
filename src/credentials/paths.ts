import os from 'node:os';
import path from 'node:path';

export const CREDENTIALS_FILE_NAME = 'credentials.json';

/**
 * `ARTEL_CONFIG_DIR` 이 있으면 그 디렉터리, 없으면 `~/.artel`.
 *
 * XDG 경로는 쓰지 않는다. 플랫폼마다 갈리면 문서와 에러 메시지가 두 벌이 되는데,
 * 필요한 것은 home 아래 파일 하나다. 이 환경 변수는 테스트가 진짜 home 을 건드리지
 * 않게 하는 손잡이이기도 하다.
 */
export function credentialsDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ARTEL_CONFIG_DIR?.trim();
  if (override) {
    return override;
  }
  return path.join(os.homedir(), '.artel');
}

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(credentialsDir(env), CREDENTIALS_FILE_NAME);
}
