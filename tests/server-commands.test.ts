import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runServerInstall } from '../src/commands/server/install.js';
import type {
  ErrorEnvelope,
  ServerDoctorPayload,
  ServerInstallPayload,
  ServerStatusPayload,
  ServerStopPayload,
} from '../src/output/contract.js';
import { parseChecksumFile, runtimeArchiveName, runtimeArchiveUrl } from '../src/server/install.js';
import { currentTarget, type RuntimeTarget } from '../src/server/paths.js';
import { EXIT_FAILURE, EXIT_OK, runCli } from '../src/run.js';
import { createMemorySink } from './helpers.js';
import { writeRuntimeSkeleton } from './server-helpers.js';

const target = currentTarget();
const supported = target !== null && process.platform !== 'win32' ? describe : describe.skip;

let xdg: string;

beforeEach(async () => {
  xdg = await fs.mkdtemp(path.join(os.tmpdir(), 'artel-server-cmd-'));
});

afterEach(async () => {
  await fs.rm(xdg, { recursive: true, force: true });
});

function linuxEnv(): NodeJS.ProcessEnv {
  return { XDG_DATA_HOME: xdg, HOME: xdg };
}

describe('runtime archive address', () => {
  it('follows the release layout in the shared contract', () => {
    expect(runtimeArchiveName('0.1.0', 'linux-x64')).toBe('artel-runtime-0.1.0-linux-x64.tar.gz');
    expect(runtimeArchiveUrl('0.1.0', 'darwin-arm64')).toBe(
      'https://github.com/project-artel/artel-desktop/releases/download/runtime-v0.1.0/artel-runtime-0.1.0-darwin-arm64.tar.gz',
    );
  });

  it('reads "<hex>  <name>" checksum files', () => {
    const digest = 'a'.repeat(64);
    expect(parseChecksumFile(`${digest}  artel.tar.gz\n`, 'artel.tar.gz')).toBe(digest);
    expect(() => parseChecksumFile(`${digest}  other.tar.gz`, 'artel.tar.gz')).toThrow(
      /names other/,
    );
    expect(() => parseChecksumFile('nope', 'artel.tar.gz')).toThrow();
  });
});

supported('artel server install', () => {
  const runtimeTarget = target as RuntimeTarget;
  let archive: Buffer;
  let checksum: string;

  beforeEach(async () => {
    const staging = path.join(xdg, 'staging');
    const top = `artel-runtime-0.1.0-${runtimeTarget}`;
    await writeRuntimeSkeleton(path.join(staging, top));
    const archivePath = path.join(xdg, 'archive.tar.gz');
    execFileSync('tar', ['-czf', archivePath, '-C', staging, top]);
    archive = await fs.readFile(archivePath);
    checksum = crypto.createHash('sha256').update(archive).digest('hex');
  });

  function fakeFetch(digest: string): typeof fetch {
    return (input) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = url.endsWith('.sha256')
        ? `${digest}  ${runtimeArchiveName('0.1.0', runtimeTarget)}\n`
        : new Uint8Array(archive);
      return Promise.resolve(new Response(body, { status: 200 }));
    };
  }

  it('downloads, verifies and unpacks the runtime, then skips it the second time', async () => {
    const sink = createMemorySink();
    await runServerInstall({ json: true }, sink, linuxEnv(), { fetchImpl: fakeFetch(checksum) });
    const payload = sink.lastJson<ServerInstallPayload>();
    expect(Object.keys(payload).sort()).toEqual([
      'alreadyInstalled',
      'runtimeDir',
      'sha256',
      'target',
      'version',
    ]);
    expect(payload).toMatchObject({ version: '0.1.0', alreadyInstalled: false, sha256: checksum });
    expect(payload.runtimeDir).toBe(path.join(xdg, 'artel', 'runtime', '0.1.0'));
    await fs.access(path.join(payload.runtimeDir, 'manifest.json'));

    const again = createMemorySink();
    await runServerInstall({ json: true }, again, linuxEnv(), { fetchImpl: fakeFetch(checksum) });
    expect(again.lastJson<ServerInstallPayload>().alreadyInstalled).toBe(true);
  });

  it('installs nothing when the checksum does not match', async () => {
    const sink = createMemorySink();
    await expect(
      runServerInstall({ json: true }, sink, linuxEnv(), { fetchImpl: fakeFetch('0'.repeat(64)) }),
    ).rejects.toMatchObject({ code: 'server_checksum_mismatch' });
    await expect(fs.access(path.join(xdg, 'artel', 'runtime', '0.1.0'))).rejects.toThrow();
  });
});

describe.skipIf(process.platform !== 'linux')('artel server status, stop and doctor', () => {
  it('reports a stopped stack with a stable --json shape', async () => {
    const sink = createMemorySink();
    expect(await runCli(['server', 'status', '--json'], sink, linuxEnv())).toBe(EXIT_OK);
    const payload = sink.lastJson<ServerStatusPayload>();
    expect(Object.keys(payload).sort()).toEqual([
      'dataDir',
      'logDir',
      'pid',
      'running',
      'services',
      'url',
    ]);
    expect(payload).toMatchObject({
      running: false,
      url: null,
      pid: null,
      dataDir: path.join(xdg, 'artel'),
      services: {
        postgres: 'stopped',
        orchestration: 'stopped',
        'agent-server': 'stopped',
        proxy: 'stopped',
      },
    });
  });

  it('stops nothing when nothing runs', async () => {
    const sink = createMemorySink();
    expect(await runCli(['server', 'stop', '--json'], sink, linuxEnv())).toBe(EXIT_OK);
    expect(sink.lastJson<ServerStopPayload>()).toEqual({
      wasRunning: false,
      dataDir: path.join(xdg, 'artel'),
    });
  });

  it('doctor fails without a runtime and names the install command', async () => {
    const sink = createMemorySink();
    expect(await runCli(['server', 'doctor', '--json'], sink, linuxEnv())).toBe(EXIT_FAILURE);
    const payload = sink.lastJson<ServerDoctorPayload>();
    expect(payload.ok).toBe(false);
    expect(payload.checks.map((check) => check.name)).toEqual([
      'runtime',
      'version',
      'privileges',
      'data-dir',
      'disk',
      'ports',
    ]);
    expect(payload.checks[0]?.detail).toContain('artel server install');
  });

  it('doctor passes with a valid runtime', async () => {
    await writeRuntimeSkeleton(path.join(xdg, 'artel', 'runtime', '0.1.0'));
    const sink = createMemorySink();
    await runCli(['server', 'doctor', '--json'], sink, linuxEnv());
    const payload = sink.lastJson<ServerDoctorPayload>();
    expect(payload.checks.find((check) => check.name === 'runtime')?.status).toBe('ok');
    expect(payload.checks.find((check) => check.name === 'version')?.status).toBe('ok');
  });

  it('start in the foreground fails with a JSON error when no runtime is installed', async () => {
    const sink = createMemorySink();
    expect(await runCli(['server', 'start', '--foreground', '--json'], sink, linuxEnv())).toBe(
      EXIT_FAILURE,
    );
    expect(sink.lastJson<ErrorEnvelope>().error.code).toBe('server_runtime_missing');
  });

  it('rejects an unknown log service', async () => {
    const sink = createMemorySink();
    expect(await runCli(['server', 'logs', 'redis'], sink, linuxEnv())).toBe(2);
  });
});
