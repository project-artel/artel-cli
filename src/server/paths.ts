import os from 'node:os';
import path from 'node:path';

/**
 * 이 CLI 가 받는 runtime bundle 의 버전. `artel server install` 이 기본으로 받는 버전이고,
 * `ARTEL_RUNTIME_DIR` 이 없을 때 `<dataDir>/runtime/<version>` 을 찾는 기준이다.
 */
export const RUNTIME_VERSION = '0.1.0';

export type RuntimeTarget =
  'linux-x64' | 'linux-arm64' | 'darwin-x64' | 'darwin-arm64' | 'win32-x64' | 'win32-arm64';

export const RUNTIME_TARGETS: readonly RuntimeTarget[] = [
  'linux-x64',
  'linux-arm64',
  'darwin-x64',
  'darwin-arm64',
  'win32-x64',
  'win32-arm64',
];

/** `process.platform-process.arch`. bundle 이 없는 조합이면 `null` 이다. */
export function currentTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): RuntimeTarget | null {
  const candidate = `${platform}-${arch}`;
  return (RUNTIME_TARGETS as readonly string[]).includes(candidate)
    ? (candidate as RuntimeTarget)
    : null;
}

/**
 * OS 마다 정해진 데이터 디렉터리. Linux 는 `$XDG_DATA_HOME/artel`, 없으면
 * `~/.local/share/artel` 이다.
 */
export function defaultDataDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDir: string = os.homedir(),
): string {
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA?.trim() || path.win32.join(homeDir, 'AppData', 'Local');
    return path.win32.join(localAppData, 'ARTEL');
  }
  if (platform === 'darwin') {
    return path.posix.join(homeDir, 'Library', 'Application Support', 'ARTEL');
  }
  const xdg = env.XDG_DATA_HOME?.trim();
  return xdg ? path.posix.join(xdg, 'artel') : path.posix.join(homeDir, '.local', 'share', 'artel');
}

export interface DataPaths {
  dataDir: string;
  configFile: string;
  stateFile: string;
  pgdata: string;
  storage: string;
  home: string;
  /** `home/` 을 어느 runtime 버전과 어느 URL 로 만들었는지 적어 두는 파일. */
  homeStamp: string;
  logs: string;
  runtimeRoot: string;
  /** POSIX 에서 postgres 의 unix socket 을 두는 곳. */
  socketDir: string;
}

export function dataPaths(dataDir: string): DataPaths {
  return {
    dataDir,
    configFile: path.join(dataDir, 'config.json'),
    stateFile: path.join(dataDir, 'state.json'),
    pgdata: path.join(dataDir, 'pgdata'),
    storage: path.join(dataDir, 'storage'),
    home: path.join(dataDir, 'home'),
    homeStamp: path.join(dataDir, 'home.stamp.json'),
    logs: path.join(dataDir, 'logs'),
    runtimeRoot: path.join(dataDir, 'runtime'),
    socketDir: path.join(dataDir, 'run'),
  };
}

/**
 * `options.runtimeDir`, 그다음 `ARTEL_RUNTIME_DIR`, 그다음 `<dataDir>/runtime/<version>`.
 * desktop app 은 `ARTEL_RUNTIME_DIR` 로 installer 에 들어 있는 bundle 을 가리킨다.
 */
export function resolveRuntimeDir(
  dataDir: string,
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromOption = explicit?.trim();
  if (fromOption) return fromOption;
  const fromEnv = env.ARTEL_RUNTIME_DIR?.trim();
  if (fromEnv) return fromEnv;
  return path.join(dataPaths(dataDir).runtimeRoot, RUNTIME_VERSION);
}
