import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

import { isPidAlive } from './state-file.js';

export interface SpawnServiceOptions {
  command: string;
  args: readonly string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  onLine: (line: string) => void;
}

/**
 * POSIX 에서는 child 를 자기 process group 으로 띄운다. 터미널의 Ctrl-C 는 foreground process
 * group 전체에 SIGINT 를 보내는데, child 가 같은 group 이면 supervisor 가 순서대로 멈추기 전에
 * child 가 먼저 죽고 supervisor 는 그것을 crash 로 보고 다시 띄운다. Windows 의 `detached` 는
 * 새 console 창을 여는 뜻이라 쓰지 않는다.
 */
export function spawnService(options: SpawnServiceOptions): ChildProcess {
  const child = spawn(options.command, [...options.args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  let pendingOut = '';
  let pendingErr = '';
  const split = (chunk: Buffer, pending: string): string => {
    const lines = (pending + chunk.toString('utf8')).split(/\r?\n/);
    const rest = lines.pop() ?? '';
    for (const line of lines) options.onLine(line);
    return rest;
  };
  child.stdout?.on('data', (chunk: Buffer) => {
    pendingOut = split(chunk, pendingOut);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    pendingErr = split(chunk, pendingErr);
  });
  child.on('close', () => {
    if (pendingOut) options.onLine(pendingOut);
    if (pendingErr) options.onLine(pendingErr);
  });
  return child;
}

export interface RunResult {
  code: number | null;
  output: string;
}

/** 끝날 때까지 기다리는 짧은 명령(`initdb`, `pg_ctl`, `createdb`). 출력은 줄마다 `onLine` 으로도 보낸다. */
export function runToCompletion(
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; cwd?: string; onLine?: (line: string) => void },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    const child = spawnService({
      command,
      args,
      env: options.env,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      onLine: (line) => {
        lines.push(line);
        options.onLine?.(line);
      },
    });
    child.once('error', (error) => {
      resolve({ code: null, output: `${lines.join('\n')}\n${error.message}`.trim() });
    });
    child.once('close', (code) => {
      resolve({ code, output: lines.join('\n') });
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await sleep(100);
  }
  return !isPidAlive(pid);
}

/**
 * pid 와 그 아래 process 를 멈춘다. POSIX 는 process group 에 SIGTERM, `timeoutMs` 뒤에도 살아
 * 있으면 SIGKILL. Windows 는 `taskkill /T` 로 tree 를 닫고, 그래도 남으면 `/F` 를 붙인다.
 */
export async function stopProcessTree(pid: number, timeoutMs: number): Promise<void> {
  if (!isPidAlive(pid)) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T'], { stdio: 'ignore', windowsHide: true });
    if (await waitForExit(pid, timeoutMs)) return;
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    await waitForExit(pid, 5_000);
    return;
  }
  signalGroup(pid, 'SIGTERM');
  if (await waitForExit(pid, timeoutMs)) return;
  signalGroup(pid, 'SIGKILL');
  await waitForExit(pid, 5_000);
}

/** group 으로 보내지 못하면(자기 group 의 leader 가 아니면) 그 process 하나에 보낸다. */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // group leader 가 아니다.
  }
  try {
    process.kill(pid, signal);
  } catch {
    // 이미 끝났다.
  }
}
