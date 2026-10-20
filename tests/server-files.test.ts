import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  generateSecrets,
  loadOrCreateStackConfig,
  readStackConfig,
  resolvePorts,
} from '../src/server/config-file.js';
import { SupervisorError } from '../src/server/errors.js';
import { prepareHome } from '../src/server/home.js';
import { loadRuntime, parseManifest } from '../src/server/manifest.js';
import {
  currentTarget,
  dataPaths,
  defaultDataDir,
  resolveRuntimeDir,
} from '../src/server/paths.js';
import { assertNotPrivileged } from '../src/server/privilege.js';
import { postgresSettings } from '../src/server/services.js';
import { RotatingLog } from '../src/server/logs.js';
import { fakeManifest, writeRuntimeSkeleton } from './server-helpers.js';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'artel-server-files-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function occupy(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function freePort(): Promise<number> {
  const server = await occupy(0);
  const port = (server.address() as net.AddressInfo).port;
  await closeServer(server);
  return port;
}

describe('data directory', () => {
  it('follows each OS convention', () => {
    expect(defaultDataDir({ XDG_DATA_HOME: '/xdg' }, 'linux', '/home/a')).toBe('/xdg/artel');
    expect(defaultDataDir({}, 'linux', '/home/a')).toBe('/home/a/.local/share/artel');
    expect(defaultDataDir({}, 'darwin', '/Users/a')).toBe(
      '/Users/a/Library/Application Support/ARTEL',
    );
    expect(
      defaultDataDir({ LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'win32', 'C:\\Users\\a'),
    ).toBe('C:\\Users\\a\\AppData\\Local\\ARTEL');
  });

  it('takes the runtime from the option, then ARTEL_RUNTIME_DIR, then the data directory', () => {
    expect(resolveRuntimeDir('/data', '/explicit', { ARTEL_RUNTIME_DIR: '/env' })).toBe(
      '/explicit',
    );
    expect(resolveRuntimeDir('/data', undefined, { ARTEL_RUNTIME_DIR: '/env' })).toBe('/env');
    expect(resolveRuntimeDir('/data', undefined, {})).toBe(path.join('/data', 'runtime', '0.1.0'));
  });

  it('names the target the way Node does', () => {
    expect(currentTarget('linux', 'x64')).toBe('linux-x64');
    expect(currentTarget('win32', 'arm64')).toBe('win32-arm64');
    expect(currentTarget('freebsd', 'x64')).toBeNull();
  });
});

describe('config.json', () => {
  it('generates 48-byte secrets', () => {
    const secrets = generateSecrets();
    expect(Buffer.from(secrets.jwtSecret, 'base64')).toHaveLength(48);
    expect(Buffer.from(secrets.secretsKey, 'base64')).toHaveLength(48);
    expect(secrets.dbPassword).toMatch(/^[0-9a-f]{48}$/);
  });

  it.skipIf(process.platform === 'win32')(
    'is written with mode 0600 and keeps its secrets',
    async () => {
      const file = path.join(root, 'config.json');
      const first = await loadOrCreateStackConfig(file, { host: '127.0.0.1' });
      const stat = await fs.stat(file);
      expect(stat.mode & 0o777).toBe(0o600);
      const second = await loadOrCreateStackConfig(file, { host: '127.0.0.1' });
      expect(second.jwtSecret).toBe(first.jwtSecret);
      expect(second.secretsKey).toBe(first.secretsKey);
      expect(second.dbPassword).toBe(first.dbPassword);
      expect(await readStackConfig(file)).toEqual(second);
    },
  );

  it('keeps every chosen port distinct', async () => {
    const ports = await resolvePorts(null, { host: '127.0.0.1' });
    expect(new Set(Object.values(ports)).size).toBe(5);
  });

  it('reuses a saved port while it is free and moves off one another program holds', async () => {
    const saved = {
      proxy: await freePort(),
      postgres: await freePort(),
      orchestration: await freePort(),
      orchestrationInternal: await freePort(),
      agentServer: await freePort(),
    };
    const blocker = await occupy(saved.postgres);
    try {
      const ports = await resolvePorts(saved, { host: '127.0.0.1' });
      expect(ports.proxy).toBe(saved.proxy);
      expect(ports.orchestration).toBe(saved.orchestration);
      expect(ports.postgres).not.toBe(saved.postgres);
    } finally {
      await closeServer(blocker);
    }
  });

  it('refuses a --port that is taken instead of moving silently', async () => {
    const blocker = await occupy(0);
    const port = (blocker.address() as net.AddressInfo).port;
    try {
      await expect(
        resolvePorts(null, { host: '127.0.0.1', proxyPort: port }),
      ).rejects.toMatchObject({
        code: 'server_port_in_use',
      });
    } finally {
      await closeServer(blocker);
    }
  });
});

describe('manifest', () => {
  it('parses the contract example', () => {
    const manifest = parseManifest(fakeManifest({ target: 'linux-x64' }));
    expect(manifest.executables.pg_ctl).toBe('postgres/bin/pg_ctl');
    expect(manifest.target).toBe('linux-x64');
  });

  it.each([
    [{ schemaVersion: 2 }, /schemaVersion 2/],
    [{ target: 'plan9-x64' }, /unknown target/],
    [{ orchestrationJar: '../outside.jar' }, /leaves the runtime directory/],
    [{ homeDir: '/abs/home' }, /leaves the runtime directory/],
    [{ agentServerDir: 'agent\\server' }, /backslash/],
    [{ executables: { java: 'java/bin/java' } }, /executables\.postgres/],
  ])('rejects %j', (overrides, message) => {
    expect(() => parseManifest(fakeManifest(overrides))).toThrow(message);
  });

  it('names the missing file when the bundle is incomplete', async () => {
    const runtimeDir = path.join(root, 'runtime');
    await writeRuntimeSkeleton(runtimeDir);
    await fs.rm(path.join(runtimeDir, 'orchestration', 'orchestration.jar'));
    await expect(loadRuntime(runtimeDir)).rejects.toThrow(/orchestration\.jar is missing/);
  });

  it('tells the user to install when there is no runtime', async () => {
    await expect(loadRuntime(path.join(root, 'nothing'))).rejects.toMatchObject({
      code: 'server_runtime_missing',
    });
  });
});

describe('home placeholder', () => {
  it('replaces the placeholder in text files and redoes it only when the URL or version changes', async () => {
    const runtimeDir = path.join(root, 'runtime');
    await writeRuntimeSkeleton(runtimeDir);
    await fs.writeFile(
      path.join(runtimeDir, 'home', 'assets', 'logo.png'),
      Buffer.from([0x89, 0x50]),
    );
    const paths = dataPaths(path.join(root, 'data'));
    const prepare = (url: string, runtimeVersion = '0.1.0') =>
      prepareHome({
        runtimeHomeDir: path.join(runtimeDir, 'home'),
        homeDir: paths.home,
        stampFile: paths.homeStamp,
        runtimeVersion,
        url,
      });

    expect(await prepare('http://127.0.0.1:8088')).toBe(true);
    expect(await fs.readFile(path.join(paths.home, 'assets', 'app.js'), 'utf8')).toBe(
      'const base = "http://127.0.0.1:8088/api";',
    );
    expect(await fs.readFile(path.join(paths.home, 'index.html'), 'utf8')).not.toContain(
      '__ARTEL_ORCHESTRATION_URL__',
    );
    expect([...(await fs.readFile(path.join(paths.home, 'assets', 'logo.png')))]).toEqual([
      0x89, 0x50,
    ]);

    expect(await prepare('http://127.0.0.1:8088')).toBe(false);
    expect(await prepare('https://artel.example.com')).toBe(true);
    expect(await fs.readFile(path.join(paths.home, 'assets', 'app.js'), 'utf8')).toBe(
      'const base = "https://artel.example.com/api";',
    );
    expect(await prepare('https://artel.example.com', '0.2.0')).toBe(true);
  });
});

describe('postgres settings', () => {
  it('quotes a socket directory with a space and binds to loopback', () => {
    const text = postgresSettings({
      port: 5544,
      socketDir: "/Users/a/Library/Application Support/ARTEL/it's",
    });
    expect(text).toContain("listen_addresses = '127.0.0.1'");
    expect(text).toContain('port = 5544');
    expect(text).toContain("shared_buffers = '64MB'");
    expect(text).toContain(
      "unix_socket_directories = '/Users/a/Library/Application Support/ARTEL/it''s'",
    );
  });
});

describe('privileges', () => {
  it('refuses root on POSIX and an elevated shell on Windows', () => {
    expect(() => assertNotPrivileged('linux', () => 0)).toThrow(SupervisorError);
    expect(() => assertNotPrivileged('linux', () => 0)).toThrow(/as root/);
    expect(() => assertNotPrivileged('linux', () => 1000)).not.toThrow();
    expect(() => assertNotPrivileged('win32', undefined, () => true)).toThrow(/elevated/);
    expect(() => assertNotPrivileged('win32', undefined, () => false)).not.toThrow();
  });
});

describe('rotating log', () => {
  it('moves the file to .1 when it passes the size limit', async () => {
    const file = path.join(root, 'logs', 'orchestration.log');
    const log = new RotatingLog(file, 50, 2);
    for (let index = 0; index < 13; index += 1) log.write(`line ${String(index)} padding`);
    log.close();
    const files = (await fs.readdir(path.join(root, 'logs'))).sort();
    expect(files).toEqual(['orchestration.log', 'orchestration.log.1', 'orchestration.log.2']);
  });
});
