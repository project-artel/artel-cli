import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import type net from 'node:net';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runServerStart } from '../src/commands/server/start.js';
import type { ServerStartPayload } from '../src/output/contract.js';
import { runtimeArchiveName } from '../src/server/install.js';
import { currentTarget, type RuntimeTarget } from '../src/server/paths.js';
import { readState } from '../src/server/state-file.js';
import { stopStackWithInternals } from '../src/server/supervisor.js';
import { createMemorySink } from './helpers.js';
import { createFakeRuntime, waitFor, type FakeRuntime } from './server-helpers.js';

const target = currentTarget();
const supported = target !== null && process.platform === 'linux' ? describe : describe.skip;

interface ReleaseFixture {
  baseUrl: string;
  requests: string[];
  close(): Promise<void>;
}

/** GitHub Releases 대신 쓰는 local HTTP server. `/runtime-v<version>/<archive>` 와 `.sha256` 을 낸다. */
function startReleaseFixture(archive: Buffer, digest: string): Promise<ReleaseFixture> {
  const name = runtimeArchiveName('0.1.0', target as RuntimeTarget);
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? '');
    if (req.url === `/runtime-v0.1.0/${name}.sha256`) {
      res.end(`${digest}  ${name}\n`);
    } else if (req.url === `/runtime-v0.1.0/${name}`) {
      res.writeHead(200, { 'content-length': String(archive.length) });
      res.end(archive);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        baseUrl: `http://127.0.0.1:${String(port)}`,
        requests,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

supported('artel server start with a missing runtime', () => {
  let runtime: FakeRuntime;
  let archive: Buffer;
  let digest: string;
  let fixture: ReleaseFixture | null = null;

  beforeEach(async () => {
    // fake runtime 을 archive 로 묶는다. 풀린 runtime 의 실행 파일은 fake script 를 절대 경로로 부른다.
    runtime = await createFakeRuntime();
    const archivePath = path.join(runtime.root, 'archive.tar.gz');
    execFileSync('tar', ['-czf', archivePath, '-C', runtime.root, 'runtime']);
    archive = await fs.readFile(archivePath);
    digest = crypto.createHash('sha256').update(archive).digest('hex');
  });

  afterEach(async () => {
    await fixture?.close();
    fixture = null;
    await runtime.cleanup();
  });

  const env = (): NodeJS.ProcessEnv => ({
    XDG_DATA_HOME: path.join(runtime.root, 'xdg'),
    HOME: runtime.root,
  });
  const dataDir = (): string => path.join(runtime.root, 'xdg', 'artel');
  const installedDir = (): string => path.join(dataDir(), 'runtime', '0.1.0');

  it('downloads the runtime, then starts the stack', async () => {
    fixture = await startReleaseFixture(archive, digest);
    const sink = createMemorySink();
    const running = runServerStart({ json: false, foreground: true, install: true }, sink, env(), {
      baseUrl: fixture.baseUrl,
    });

    const state = await waitFor(async () => {
      const current = await readState(path.join(dataDir(), 'state.json'));
      return current?.services.proxy === 'ready' ? current : null;
    }, 20_000);
    expect(state.runtimeDir).toBe(installedDir());
    await fs.access(path.join(installedDir(), 'manifest.json'));
    expect(fixture.requests).toHaveLength(2);
    expect(sink.stderr.some((line) => /\(100%\)$/.test(line))).toBe(true);
    expect(sink.stdout[0]).toMatch(/^ARTEL is running at http:\/\/127\.0\.0\.1:\d+$/);

    await stopStackWithInternals({ dataDir: dataDir() }, { env: env() });
    await running;
    const records = await runtime.records();
    expect(records.map((line) => line.split(' ')[0]).slice(0, 5)).toEqual([
      'initdb',
      'pg_ctl',
      'createdb',
      'orchestration',
      'agent-server',
    ]);
  }, 30_000);

  it('reports installed in --json and writes no progress to stdout', async () => {
    fixture = await startReleaseFixture(archive, digest);
    const sink = createMemorySink();
    const running = runServerStart({ json: true, foreground: true, install: true }, sink, env(), {
      baseUrl: fixture.baseUrl,
    });
    await waitFor(() => sink.stdout.length > 0, 20_000);
    await stopStackWithInternals({ dataDir: dataDir() }, { env: env() });
    await running;

    expect(sink.stdout).toHaveLength(1);
    const payload = sink.lastJson<ServerStartPayload>();
    expect(Object.keys(payload).sort()).toEqual([
      'attached',
      'dataDir',
      'installed',
      'pid',
      'url',
      'warnings',
    ]);
    expect(payload).toMatchObject({ attached: false, installed: true, pid: process.pid });
    expect(sink.stderr.some((line) => line.includes('%'))).toBe(false);
  }, 30_000);

  it('fails on a checksum mismatch and leaves nothing behind', async () => {
    fixture = await startReleaseFixture(archive, '0'.repeat(64));
    const sink = createMemorySink();
    await expect(
      runServerStart({ json: false, foreground: true, install: true }, sink, env(), {
        baseUrl: fixture.baseUrl,
      }),
    ).rejects.toMatchObject({ code: 'server_checksum_mismatch' });

    expect(await fs.readdir(path.join(dataDir(), 'runtime'))).toEqual([]);
    expect(await readState(path.join(dataDir(), 'state.json'))).toBeNull();
    expect(await runtime.records()).toEqual([]);
  });

  it('never downloads when ARTEL_RUNTIME_DIR points at nothing', async () => {
    fixture = await startReleaseFixture(archive, digest);
    const sink = createMemorySink();
    await expect(
      runServerStart(
        { json: false, foreground: true, install: true },
        sink,
        { ...env(), ARTEL_RUNTIME_DIR: path.join(runtime.root, 'missing') },
        { baseUrl: fixture.baseUrl },
      ),
    ).rejects.toMatchObject({ code: 'server_runtime_missing' });
    expect(fixture.requests).toEqual([]);
  });

  it('with --no-install fails without a request', async () => {
    fixture = await startReleaseFixture(archive, digest);
    const sink = createMemorySink();
    await expect(
      runServerStart({ json: false, foreground: true, install: false }, sink, env(), {
        baseUrl: fixture.baseUrl,
      }),
    ).rejects.toThrow(/Run "artel server install", or drop --no-install/);
    expect(fixture.requests).toEqual([]);
  });
});
