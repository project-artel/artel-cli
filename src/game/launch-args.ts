export const DEFAULT_SCREEN_WIDTH = 1280;
export const DEFAULT_SCREEN_HEIGHT = 720;

/**
 * `apiBaseUrl`(`http://host:port` 또는 `https://host`)에서 `-artel-server`/`-artel-secure` 로
 * 넘길 값을 뽑는다. 포트가 URL 에 안 보이는 https 는 443, http 는 80 으로 채운다 —
 * `-artel-server` 는 `host:port` 형식을 그대로 받고 기본 포트를 스스로 채우지 않는다.
 */
export function deriveGameServerAddress(apiBaseUrl: string): {
  serverAddress: string;
  secure: boolean;
} {
  const url = new URL(apiBaseUrl);
  const secure = url.protocol === 'https:';
  const port = url.port.length > 0 ? url.port : secure ? '443' : '80';
  return { serverAddress: `${url.hostname}:${port}`, secure };
}

export interface GameLaunchArgsOptions {
  serverAddress: string;
  secure: boolean;
  frontendUrl: string;
  /**
   * 로그인시킬 프로젝트. `logout` 실행에서는 없다 — 지우러 가는 실행에 프로젝트를 실으면
   * SDK 가 지운 자리에 그것을 도로 심는다.
   */
  projectId: string | null;
  logFilePath: string;
  width: number;
  height: number;
  /** `artel game logout` 만 켠다. */
  logout: boolean;
}

/**
 * ARTEL-787(artel-sdk)이 받기로 한 launch argument 그대로다. token 은 여기 없다 — 그건
 * `game/process.ts` 가 자식의 환경 변수 `ARTEL_SDK_TOKEN` 으로만 넘긴다. argv 는 같은 머신의
 * 다른 사용자에게 `ps` 로 보인다.
 *
 * `-batchmode` 는 절대 넣지 않는다: SDK 의 화면 캡처는 back buffer 를 읽는데 batchmode 는
 * 그걸 만들지 않아서 캡처가 조용히 빈 화면으로 나온다(README 참고).
 */
export function buildGameLaunchArgs(options: GameLaunchArgsOptions): string[] {
  const args = [
    '-artel-server',
    options.serverAddress,
    '-artel-secure',
    String(options.secure),
    '-artel-frontend',
    options.frontendUrl,
    '-logFile',
    options.logFilePath,
    '-screen-width',
    String(options.width),
    '-screen-height',
    String(options.height),
  ];

  if (options.projectId !== null) {
    args.push('-artel-project', options.projectId);
  }
  if (options.logout) {
    args.push('-artel-logout');
  }
  return args;
}
