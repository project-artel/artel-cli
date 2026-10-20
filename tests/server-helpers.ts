import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * 진짜 PostgreSQL, JVM, Python 대신 쓰는 작은 node script 들. manifest 가 가리키는 실행 파일
 * 자리에 이 script 를 부르는 shell wrapper 를 둔다. 각 script 는 무엇을 했는지 `record.log` 에
 * 한 줄씩 남겨, 테스트가 start 순서와 넘긴 인자를 확인한다.
 */
const FAKE_SCRIPTS: Record<string, string> = {
  'record.mjs': `
import fs from 'node:fs';
export function record(dir, line) {
  fs.appendFileSync(dir + '/record.log', line + '\\n');
}
export function argAfter(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}
`,
  'initdb.mjs': `
import fs from 'node:fs';
import { record, argAfter } from './record.mjs';
const [recordDir, ...args] = process.argv.slice(2);
const dataDir = argAfter(args, '-D');
const pwfile = args.find((a) => a.startsWith('--pwfile='))?.slice('--pwfile='.length);
const mode = (fs.statSync(pwfile).mode & 0o777).toString(8);
record(recordDir, 'initdb ' + args.filter((a) => !a.startsWith('--pwfile=')).join(' ') + ' pwfile-mode=' + mode);
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(dataDir + '/PG_VERSION', '16\\n');
fs.writeFileSync(dataDir + '/postgresql.conf', '# fake\\n');
`,
  'postgres-server.mjs': `
import fs from 'node:fs';
import net from 'node:net';
const [dataDir, port] = process.argv.slice(2);
const server = net.createServer((socket) => socket.end());
server.listen(Number(port), '127.0.0.1', () => {
  fs.writeFileSync(dataDir + '/postmaster.pid', process.pid + '\\n' + dataDir + '\\n');
  console.log('database system is ready to accept connections');
});
process.on('SIGTERM', () => {
  fs.rmSync(dataDir + '/postmaster.pid', { force: true });
  process.exit(0);
});
`,
  'pg_ctl.mjs': `
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { record, argAfter } from './record.mjs';
const [recordDir, command, ...args] = process.argv.slice(2);
const dataDir = argAfter(args, '-D');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
if (command === 'start') {
  const conf = fs.readFileSync(dataDir + '/artel.conf', 'utf8');
  const port = /^port = (\\d+)/m.exec(conf)[1];
  record(recordDir, 'pg_ctl start port=' + port + ' log=' + argAfter(args, '-l'));
  const out = fs.openSync(argAfter(args, '-l'), 'a');
  const script = fileURLToPath(new URL('./postgres-server.mjs', import.meta.url));
  const child = spawn(process.execPath, [script, dataDir, port], { detached: true, stdio: ['ignore', out, out] });
  child.unref();
  for (let i = 0; i < 100; i += 1) {
    const ok = await new Promise((resolve) => {
      const s = net.connect(Number(port), '127.0.0.1');
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => resolve(false));
    });
    if (ok) process.exit(0);
    await sleep(50);
  }
  process.exit(1);
}
if (command === 'stop') {
  record(recordDir, 'pg_ctl stop ' + args.join(' '));
  let pid = null;
  try { pid = Number(fs.readFileSync(dataDir + '/postmaster.pid', 'utf8').split('\\n')[0]); } catch {}
  if (pid) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
    for (let i = 0; i < 100 && alive(pid); i += 1) await sleep(50);
  }
  process.exit(0);
}
process.exit(1);
`,
  'pg_isready.mjs': `
import net from 'node:net';
import { argAfter } from './record.mjs';
const args = process.argv.slice(3);
const port = Number(argAfter(args, '-p'));
const s = net.connect(port, '127.0.0.1');
s.once('connect', () => { s.destroy(); process.exit(0); });
s.once('error', () => process.exit(2));
`,
  'createdb.mjs': `
import { record } from './record.mjs';
const [recordDir, ...args] = process.argv.slice(2);
record(recordDir, 'createdb ' + args.join(' ') + ' password=' + (process.env.PGPASSWORD ? 'set' : 'unset'));
`,
  'java.mjs': `
import fs from 'node:fs';
import http from 'node:http';
import { record } from './record.mjs';
const [recordDir, ...args] = process.argv.slice(2);
if (fs.existsSync(recordDir + '/orchestration-fails')) {
  record(recordDir, 'orchestration refused');
  console.error('orchestration refuses to start');
  process.exit(3);
}
record(recordDir, 'orchestration ' + args.join(' ') + ' pid=' + process.pid);
const keys = Object.keys(process.env).filter((k) => k.startsWith('ARTEL_') || k.startsWith('DB_') || k === 'SERVER_PORT' || k.startsWith('LOGGING_'));
fs.writeFileSync(recordDir + '/orchestration-env.json', JSON.stringify(Object.fromEntries(keys.map((k) => [k, process.env[k]]))));
const server = http.createServer((req, res) => {
  if (req.url === '/api/auth/me') { res.writeHead(401); res.end(); return; }
  if (req.url === '/api/crash') { res.writeHead(200); res.end(); setTimeout(() => process.exit(1), 10); return; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ url: req.url, headers: req.headers }));
});
server.listen(Number(process.env.SERVER_PORT), '127.0.0.1', () => console.log('Started OrchestrationApplication'));
process.on('SIGTERM', () => { record(recordDir, 'orchestration SIGTERM'); process.exit(0); });
`,
  'python.mjs': `
import fs from 'node:fs';
import http from 'node:http';
import { record, argAfter } from './record.mjs';
const [recordDir, ...args] = process.argv.slice(2);
record(recordDir, 'agent-server ' + args.join(' ') + ' cwd=' + process.cwd().split('/').pop() + ' store=' + process.env.SESSION_STORE + ' orchestration=' + process.env.ORCHESTRATION_BASE_URL);
const server = http.createServer((req, res) => {
  res.writeHead(req.url === '/health' ? 200 : 404);
  res.end();
});
server.listen(Number(argAfter(args, '--port')), '127.0.0.1', () => console.log('Uvicorn running'));
process.on('SIGTERM', () => { record(recordDir, 'agent-server SIGTERM'); process.exit(0); });
`,
};

const EXECUTABLES: Record<string, string> = {
  postgres: 'postgres/bin/postgres',
  initdb: 'postgres/bin/initdb',
  pg_ctl: 'postgres/bin/pg_ctl',
  pg_isready: 'postgres/bin/pg_isready',
  createdb: 'postgres/bin/createdb',
  java: 'java/bin/java',
  python: 'python/bin/python3',
};

const SCRIPT_FOR: Record<string, string> = {
  postgres: 'postgres-server.mjs',
  initdb: 'initdb.mjs',
  pg_ctl: 'pg_ctl.mjs',
  pg_isready: 'pg_isready.mjs',
  createdb: 'createdb.mjs',
  java: 'java.mjs',
  python: 'python.mjs',
};

export interface FakeRuntime {
  root: string;
  runtimeDir: string;
  dataDir: string;
  /** fake 가 남긴 줄. */
  records(): Promise<string[]>;
  cleanup(): Promise<void>;
}

export function fakeManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    version: '0.1.0',
    target: `${process.platform}-${process.arch}`,
    executables: EXECUTABLES,
    orchestrationJar: 'orchestration/orchestration.jar',
    agentServerDir: 'agent-server',
    homeDir: 'home',
    components: { postgres: '16.4' },
    sources: { orchestration: 'abc' },
    ...overrides,
  };
}

/** 실행 파일 없이 manifest 와 home 만 있는 runtime. manifest 와 install 테스트가 쓴다. */
export async function writeRuntimeSkeleton(
  runtimeDir: string,
  manifest: Record<string, unknown> = fakeManifest(),
): Promise<void> {
  await fs.mkdir(path.join(runtimeDir, 'orchestration'), { recursive: true });
  await fs.writeFile(path.join(runtimeDir, 'orchestration', 'orchestration.jar'), 'jar');
  await fs.mkdir(path.join(runtimeDir, 'agent-server', 'app'), { recursive: true });
  await fs.mkdir(path.join(runtimeDir, 'home', 'assets'), { recursive: true });
  await fs.writeFile(
    path.join(runtimeDir, 'home', 'index.html'),
    '<html><script>window.API="__ARTEL_ORCHESTRATION_URL__"</script></html>',
  );
  await fs.writeFile(
    path.join(runtimeDir, 'home', 'assets', 'app.js'),
    'const base = "__ARTEL_ORCHESTRATION_URL__/api";',
  );
  for (const relative of Object.values(EXECUTABLES)) {
    const file = path.join(runtimeDir, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  await fs.writeFile(path.join(runtimeDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

export async function createFakeRuntime(): Promise<FakeRuntime> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'artel-server-'));
  const runtimeDir = path.join(root, 'runtime');
  const dataDir = path.join(root, 'data');
  const scripts = path.join(root, 'fakes');
  await fs.mkdir(scripts, { recursive: true });
  for (const [name, source] of Object.entries(FAKE_SCRIPTS)) {
    await fs.writeFile(path.join(scripts, name), source);
  }
  await writeRuntimeSkeleton(runtimeDir);
  for (const [name, relative] of Object.entries(EXECUTABLES)) {
    const script = path.join(scripts, SCRIPT_FOR[name] ?? '');
    await fs.writeFile(
      path.join(runtimeDir, relative),
      `#!/bin/sh\nexec "${process.execPath}" "${script}" "${root}" "$@"\n`,
      { mode: 0o755 },
    );
  }
  // postgres-server 는 pg_ctl 이 record 인자 없이 부르므로 wrapper 를 쓰지 않는다.
  return {
    root,
    runtimeDir,
    dataDir,
    async records() {
      const text = await fs.readFile(path.join(root, 'record.log'), 'utf8').catch(() => '');
      return text.split('\n').filter((line) => line.length > 0);
    },
    async cleanup() {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

export async function waitFor<T>(
  check: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
