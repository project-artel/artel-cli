import fs from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_PROXY_PORT, readStackConfig, type StackPorts } from './config-file.js';
import { loadRuntime, type RuntimeLayout } from './manifest.js';
import { currentTarget, dataPaths, RUNTIME_VERSION, resolveRuntimeDir } from './paths.js';
import { isPortFree } from './ports.js';
import { assertNotPrivileged } from './privilege.js';
import { stackStatus } from './supervisor.js';

export type DoctorCheckName = 'runtime' | 'version' | 'privileges' | 'data-dir' | 'disk' | 'ports';
export type DoctorCheckStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  name: DoctorCheckName;
  status: DoctorCheckStatus;
  detail: string;
}

export interface DoctorReport {
  dataDir: string;
  runtimeDir: string;
  checks: DoctorCheck[];
}

/** PostgreSQL, JVM, 문서 저장소가 함께 쓰기에 모자라지 않을 여유 공간. 밑돌면 경고만 한다. */
export const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;

async function nearestExisting(dir: string): Promise<string> {
  let current = dir;
  for (;;) {
    try {
      await fs.access(current);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

async function checkRuntime(runtimeDir: string): Promise<[DoctorCheck, RuntimeLayout | null]> {
  try {
    const layout = await loadRuntime(runtimeDir);
    return [
      {
        name: 'runtime',
        status: 'ok',
        detail: `runtime ${layout.manifest.version} at ${runtimeDir}`,
      },
      layout,
    ];
  } catch (error) {
    return [{ name: 'runtime', status: 'fail', detail: (error as Error).message }, null];
  }
}

function checkVersion(layout: RuntimeLayout | null): DoctorCheck {
  if (layout === null) {
    return { name: 'version', status: 'fail', detail: 'no runtime to compare' };
  }
  const target = currentTarget();
  if (layout.manifest.target !== target) {
    return {
      name: 'version',
      status: 'fail',
      detail: `the runtime is built for ${layout.manifest.target}, and this machine is ${target ?? `${process.platform}-${process.arch}`}`,
    };
  }
  if (layout.manifest.version !== RUNTIME_VERSION) {
    return {
      name: 'version',
      status: 'warn',
      detail: `this CLI expects runtime ${RUNTIME_VERSION}, and the runtime is ${layout.manifest.version}`,
    };
  }
  return { name: 'version', status: 'ok', detail: `runtime ${RUNTIME_VERSION} for ${target}` };
}

function checkPrivileges(): DoctorCheck {
  try {
    assertNotPrivileged();
    return { name: 'privileges', status: 'ok', detail: 'not running as root or Administrator' };
  } catch (error) {
    return { name: 'privileges', status: 'fail', detail: (error as Error).message };
  }
}

async function checkDataDir(dataDir: string): Promise<DoctorCheck> {
  try {
    await fs.mkdir(dataDir, { recursive: true });
    const probe = path.join(dataDir, `.doctor-${String(process.pid)}`);
    await fs.writeFile(probe, 'ok');
    await fs.rm(probe, { force: true });
    return { name: 'data-dir', status: 'ok', detail: `${dataDir} is writable` };
  } catch (error) {
    return {
      name: 'data-dir',
      status: 'fail',
      detail: `${dataDir} is not writable: ${(error as Error).message}`,
    };
  }
}

async function checkDisk(dataDir: string): Promise<DoctorCheck> {
  try {
    const stats = await fs.statfs(await nearestExisting(dataDir));
    const free = stats.bavail * stats.bsize;
    const gib = (free / 1024 ** 3).toFixed(1);
    return free < MIN_FREE_BYTES
      ? { name: 'disk', status: 'warn', detail: `only ${gib} GiB free under ${dataDir}` }
      : { name: 'disk', status: 'ok', detail: `${gib} GiB free under ${dataDir}` };
  } catch (error) {
    return {
      name: 'disk',
      status: 'warn',
      detail: `could not read free space: ${(error as Error).message}`,
    };
  }
}

async function checkPorts(dataDir: string, running: boolean): Promise<DoctorCheck> {
  if (running) {
    return { name: 'ports', status: 'ok', detail: 'the stack is running and holds its ports' };
  }
  const config = await readStackConfig(dataPaths(dataDir).configFile);
  const ports: Partial<StackPorts> = config?.ports ?? { proxy: DEFAULT_PROXY_PORT };
  const busy: string[] = [];
  for (const [name, port] of Object.entries(ports)) {
    if (!(await isPortFree(port))) busy.push(`${name} ${String(port)}`);
  }
  if (busy.length === 0) {
    return { name: 'ports', status: 'ok', detail: 'every saved port is free' };
  }
  // 다른 프로그램이 잡은 저장된 port 는 start 가 새로 고른다. proxy 를 빼면 실패가 아니다.
  return {
    name: 'ports',
    status: 'warn',
    detail: `in use by another program: ${busy.join(', ')}; start will choose other ports, and the console URL changes if the proxy port moves`,
  };
}

export async function runDoctor(options: {
  dataDir: string;
  runtimeDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<DoctorReport> {
  const runtimeDir = resolveRuntimeDir(options.dataDir, options.runtimeDir, options.env);
  const [runtimeCheck, layout] = await checkRuntime(runtimeDir);
  const status = await stackStatus({ dataDir: options.dataDir });
  return {
    dataDir: options.dataDir,
    runtimeDir,
    checks: [
      runtimeCheck,
      checkVersion(layout),
      checkPrivileges(),
      await checkDataDir(options.dataDir),
      await checkDisk(options.dataDir),
      await checkPorts(options.dataDir, status.running),
    ],
  };
}
