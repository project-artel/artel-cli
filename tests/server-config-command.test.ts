import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ErrorEnvelope, ServerConfigPayload } from '../src/output/contract.js';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, runCli } from '../src/run.js';
import { createMemorySink } from './helpers.js';
import { canMakeCertificates, makeCertificate } from './tls-helpers.js';

let xdg: string;

beforeEach(async () => {
  xdg = await fs.mkdtemp(path.join(os.tmpdir(), 'artel-config-cmd-'));
});

afterEach(async () => {
  await fs.rm(xdg, { recursive: true, force: true });
});

const env = (): NodeJS.ProcessEnv => ({ XDG_DATA_HOME: xdg, HOME: xdg });

describe.skipIf(process.platform !== 'linux')('artel server config', () => {
  it('shows the defaults before any start, with a stable --json shape', async () => {
    const sink = createMemorySink();
    expect(await runCli(['server', 'config', '--json'], sink, env())).toBe(EXIT_OK);
    const payload = sink.lastJson<ServerConfigPayload>();
    expect(Object.keys(payload).sort()).toEqual([
      'changed',
      'configFile',
      'dataDir',
      'host',
      'port',
      'publicUrl',
      'restartRequired',
      'running',
      'tls',
      'warnings',
    ]);
    expect(payload).toMatchObject({
      host: '127.0.0.1',
      port: 8088,
      publicUrl: 'http://127.0.0.1:8088',
      tls: null,
      changed: false,
      running: false,
      restartRequired: false,
      warnings: [],
    });
  });

  it('sets values, persists them, and says they apply on the next start', async () => {
    const sink = createMemorySink();
    expect(
      await runCli(
        [
          'server',
          'config',
          'set',
          '--host',
          '0.0.0.0',
          '--port',
          '9100',
          '--public-url',
          'http://192.168.0.5:9100',
        ],
        sink,
        env(),
      ),
    ).toBe(EXIT_OK);
    expect(sink.stdout.join('\n')).toContain('apply on the next "artel server start"');
    expect(sink.stderr.join('\n')).toContain('passwords and session cookies');

    const shown = createMemorySink();
    await runCli(['server', 'config', '--json'], shown, env());
    expect(shown.lastJson<ServerConfigPayload>()).toMatchObject({
      host: '0.0.0.0',
      port: 9100,
      publicUrl: 'http://192.168.0.5:9100',
      warnings: [expect.stringContaining('plain http')],
    });
  });

  it('reports an invalid port as server_settings_invalid', async () => {
    const sink = createMemorySink();
    expect(
      await runCli(['server', 'config', 'set', '--public-url', 'ftp://x', '--json'], sink, env()),
    ).toBe(EXIT_FAILURE);
    expect(sink.lastJson<ErrorEnvelope>().error.code).toBe('server_settings_invalid');
  });

  it('needs both TLS files, refuses --no-tls with them, and refuses an empty change', async () => {
    const onlyCert = createMemorySink();
    expect(
      await runCli(['server', 'config', 'set', '--tls-cert', '/x.crt', '--json'], onlyCert, env()),
    ).toBe(EXIT_FAILURE);
    expect(onlyCert.lastJson<ErrorEnvelope>().error.code).toBe('server_settings_invalid');

    const both = createMemorySink();
    expect(
      await runCli(
        [
          'server',
          'config',
          'set',
          '--no-tls',
          '--tls-cert',
          '/x.crt',
          '--tls-key',
          '/x.key',
          '--json',
        ],
        both,
        env(),
      ),
    ).toBe(EXIT_FAILURE);

    const nothing = createMemorySink();
    expect(await runCli(['server', 'config', 'set'], nothing, env())).toBe(EXIT_USAGE);
  });

  it.skipIf(!canMakeCertificates)('turns TLS on and off', async () => {
    const certificate = await makeCertificate(path.join(xdg, 'tls'), 'cli');
    const on = createMemorySink();
    expect(
      await runCli(
        [
          'server',
          'config',
          'set',
          '--tls-cert',
          certificate.certFile,
          '--tls-key',
          certificate.keyFile,
          '--json',
        ],
        on,
        env(),
      ),
    ).toBe(EXIT_OK);
    expect(on.lastJson<ServerConfigPayload>()).toMatchObject({
      publicUrl: 'https://127.0.0.1:8088',
      tls: { certFile: certificate.certFile, keyFile: certificate.keyFile },
      changed: true,
    });

    const off = createMemorySink();
    expect(await runCli(['server', 'config', 'set', '--no-tls', '--json'], off, env())).toBe(
      EXIT_OK,
    );
    expect(off.lastJson<ServerConfigPayload>()).toMatchObject({
      publicUrl: 'http://127.0.0.1:8088',
      tls: null,
    });
  });
});
