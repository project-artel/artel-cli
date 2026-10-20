import { spawnSync } from 'node:child_process';

import { SupervisorError } from './errors.js';

/**
 * Windows 에서 관리자 권한 shell 인가. `net session` 은 관리자에게만 성공한다. 별도 module 없이
 * 판단할 수 있는 가장 오래 쓰여 온 방법이다.
 */
function isElevatedWindowsShell(): boolean {
  const result = spawnSync('net', ['session'], { stdio: 'ignore', windowsHide: true });
  return result.status === 0;
}

/**
 * PostgreSQL 은 root 나 관리자로는 시작하지 않는다(`postgres` 가 스스로 거절한다). 그 오류가
 * postgres log 안에 묻히기 전에 여기서 이유를 말한다.
 */
export function assertNotPrivileged(
  platform: NodeJS.Platform = process.platform,
  getuid: (() => number) | undefined = process.getuid?.bind(process),
  isElevated: () => boolean = isElevatedWindowsShell,
): void {
  if (platform === 'win32') {
    if (isElevated()) {
      throw new SupervisorError(
        'server_privileged',
        'ARTEL cannot start from an elevated (Administrator) shell: PostgreSQL refuses to run with administrator rights. Open a normal terminal and run the command again.',
      );
    }
    return;
  }
  if (getuid !== undefined && getuid() === 0) {
    throw new SupervisorError(
      'server_privileged',
      'ARTEL cannot start as root: PostgreSQL refuses to run as root. Run the command again as a regular user.',
    );
  }
}
