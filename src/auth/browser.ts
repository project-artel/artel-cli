import { spawn } from 'node:child_process';
import fs from 'node:fs';

export type BrowserOpener = (url: string) => Promise<void>;

interface OpenCommand {
  command: string;
  args: string[];
}

function isWsl(): boolean {
  if (process.platform !== 'linux') {
    return false;
  }
  try {
    return fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');
  } catch {
    return false;
  }
}

function candidatesFor(url: string, platform: NodeJS.Platform = process.platform): OpenCommand[] {
  if (platform === 'darwin') {
    return [{ command: 'open', args: [url] }];
  }
  if (platform === 'win32') {
    // `start` 의 첫 인자는 창 제목으로 먹히므로 빈 제목을 먼저 준다.
    return [{ command: 'cmd', args: ['/c', 'start', '', url] }];
  }
  if (isWsl()) {
    return [
      { command: 'wslview', args: [url] },
      { command: 'powershell.exe', args: ['-NoProfile', '-Command', 'Start-Process', url] },
      { command: 'xdg-open', args: [url] },
    ];
  }
  return [{ command: 'xdg-open', args: [url] }];
}

/**
 * `open` npm 패키지는 쓰지 않는다 — 우리에게 필요한 것은 이 20줄뿐이고 나머지는 의존성
 * 트리다. 여는 데 실패해도 로그인은 계속 기다린다. 호출하는 쪽이 URL 을 먼저 화면에
 * 찍어 두므로 사람이 손으로 열면 된다.
 */
export const openBrowser: BrowserOpener = async (url: string): Promise<void> => {
  const candidates = candidatesFor(url);
  const failures: string[] = [];

  for (const candidate of candidates) {
    try {
      await launch(candidate);
      return;
    } catch (error) {
      failures.push(`${candidate.command}: ${error instanceof Error ? error.message : 'failed'}`);
    }
  }
  throw new Error(`Could not open a browser (${failures.join('; ')})`);
};

async function launch(candidate: OpenCommand): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(candidate.command, candidate.args, {
      detached: true,
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
