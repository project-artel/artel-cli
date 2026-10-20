import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SupervisorError } from '../src/server/errors.js';
import { readStackConfig } from '../src/server/config-file.js';
import { plainTextWarning as warning } from '../src/server/stack-settings.js';
import { readStackSettings, writeStackSettings } from '../src/supervisor.js';
import { canMakeCertificates, makeCertificate, type TestCertificate } from './tls-helpers.js';

let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'artel-settings-'));
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function rejection(promise: Promise<unknown>): Promise<SupervisorError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SupervisorError) return error;
    throw error;
  }
  throw new Error('expected a SupervisorError');
}

describe('readStackSettings', () => {
  it('returns the defaults when no stack ever started', async () => {
    expect(await readStackSettings({ dataDir })).toEqual({
      host: '127.0.0.1',
      port: 8088,
      publicUrl: 'http://127.0.0.1:8088',
      tls: null,
    });
    await expect(fs.access(path.join(dataDir, 'config.json'))).rejects.toThrow();
  });
});

describe('writeStackSettings', () => {
  it('saves the changes and returns the merged settings', async () => {
    const written = await writeStackSettings({ host: '0.0.0.0', port: 9100 }, { dataDir });
    expect(written).toEqual({
      host: '0.0.0.0',
      port: 9100,
      publicUrl: 'http://127.0.0.1:9100',
      tls: null,
    });
    expect(await readStackSettings({ dataDir })).toEqual(written);

    const file = path.join(dataDir, 'config.json');
    expect((await fs.stat(file)).mode & 0o777).toBe(process.platform === 'win32' ? 0o666 : 0o600);
    const config = await readStackConfig(file);
    expect(config?.ports.proxy).toBe(9100);
    expect(config?.jwtSecret.length).toBeGreaterThan(20);
  });

  it('keeps the secrets and the other ports across writes', async () => {
    await writeStackSettings({ port: 9100 }, { dataDir });
    const first = await readStackConfig(path.join(dataDir, 'config.json'));
    await writeStackSettings({ host: '0.0.0.0' }, { dataDir });
    const second = await readStackConfig(path.join(dataDir, 'config.json'));
    expect(second?.jwtSecret).toBe(first?.jwtSecret);
    expect(second?.dbPassword).toBe(first?.dbPassword);
    expect(second?.ports).toEqual(first?.ports);
    expect(second?.host).toBe('0.0.0.0');
  });

  it('leaves the public URL to follow the port until the user sets one', async () => {
    await writeStackSettings({ port: 9100 }, { dataDir });
    expect((await writeStackSettings({ port: 9200 }, { dataDir })).publicUrl).toBe(
      'http://127.0.0.1:9200',
    );
    await writeStackSettings({ publicUrl: 'https://artel.example.com/' }, { dataDir });
    const kept = await writeStackSettings({ port: 9300 }, { dataDir });
    expect(kept.publicUrl).toBe('https://artel.example.com');
    expect((await readStackConfig(path.join(dataDir, 'config.json')))?.publicUrl).toBe(
      'https://artel.example.com',
    );
  });

  it('rejects ports outside 1 to 65535 and ports another service of the stack uses', async () => {
    for (const port of [0, -1, 65_536, 1.5, Number.NaN]) {
      const error = await rejection(writeStackSettings({ port }, { dataDir }));
      expect(error.code).toBe('server_settings_invalid');
    }
    await writeStackSettings({ port: 9100 }, { dataDir });
    const config = await readStackConfig(path.join(dataDir, 'config.json'));
    const error = await rejection(
      writeStackSettings({ port: config?.ports.postgres ?? 0 }, { dataDir }),
    );
    expect(error.message).toContain('postgres');
  });

  it('rejects a public URL that is not an absolute http or https origin', async () => {
    for (const publicUrl of [
      'artel.example.com',
      'ftp://artel.example.com',
      '/relative',
      'https://artel.example.com/console',
      'https://user:pw@artel.example.com',
    ]) {
      const error = await rejection(writeStackSettings({ publicUrl }, { dataDir }));
      expect(error.code).toBe('server_settings_invalid');
    }
    await expect(fs.access(path.join(dataDir, 'config.json'))).rejects.toThrow();
  });

  it('rejects a host with whitespace inside', async () => {
    const error = await rejection(writeStackSettings({ host: 'a b' }, { dataDir }));
    expect(error.code).toBe('server_settings_invalid');
  });
});

const tlsDescribe = canMakeCertificates ? describe : describe.skip;

tlsDescribe('writeStackSettings with TLS files', () => {
  let one: TestCertificate;
  let two: TestCertificate;

  beforeEach(async () => {
    one = await makeCertificate(dataDir, 'one');
    two = await makeCertificate(dataDir, 'two');
  });

  it('stores absolute paths and moves the default public URL to https', async () => {
    const written = await writeStackSettings(
      { tls: { certFile: one.certFile, keyFile: one.keyFile } },
      { dataDir },
    );
    expect(written.tls).toEqual({ certFile: one.certFile, keyFile: one.keyFile });
    expect(written.publicUrl).toBe('https://127.0.0.1:8088');
    expect((await readStackSettings({ dataDir })).tls).toEqual(written.tls);
  });

  it('turns TLS off with null and returns to http', async () => {
    await writeStackSettings(
      { tls: { certFile: one.certFile, keyFile: one.keyFile } },
      { dataDir },
    );
    const off = await writeStackSettings({ tls: null }, { dataDir });
    expect(off.tls).toBeNull();
    expect(off.publicUrl).toBe('http://127.0.0.1:8088');
  });

  it('rejects a missing file and a key that does not belong to the certificate', async () => {
    const missing = await rejection(
      writeStackSettings(
        { tls: { certFile: path.join(dataDir, 'nope.crt'), keyFile: one.keyFile } },
        { dataDir },
      ),
    );
    expect(missing.code).toBe('server_settings_invalid');
    expect(missing.message).toContain('nope.crt');

    const mismatch = await rejection(
      writeStackSettings({ tls: { certFile: one.certFile, keyFile: two.keyFile } }, { dataDir }),
    );
    expect(mismatch.message).toContain('not a valid pair');
  });

  it('rejects an http public URL together with TLS, in either order', async () => {
    const tls = { certFile: one.certFile, keyFile: one.keyFile };
    const together = await rejection(
      writeStackSettings({ tls, publicUrl: 'http://127.0.0.1:8088' }, { dataDir }),
    );
    expect(together.code).toBe('server_settings_invalid');

    await writeStackSettings({ publicUrl: 'http://192.168.0.5:8088' }, { dataDir });
    const later = await rejection(writeStackSettings({ tls }, { dataDir }));
    expect(later.message).toContain('publicUrl must be https');
  });

  it('allows an https public URL that points at a different front, such as a tunnel', async () => {
    const written = await writeStackSettings(
      {
        tls: { certFile: one.certFile, keyFile: one.keyFile },
        publicUrl: 'https://artel.example.com',
      },
      { dataDir },
    );
    expect(written.publicUrl).toBe('https://artel.example.com');
  });
});

describe('plainTextWarning', () => {
  it('fires for a non-loopback host with an http public URL only', () => {
    expect(warning({ host: '0.0.0.0', publicUrl: 'http://192.168.0.5:8088' })).toContain(
      'passwords and session cookies',
    );
    expect(warning({ host: '0.0.0.0', publicUrl: 'https://artel.example.com' })).toBeNull();
    expect(warning({ host: '127.0.0.1', publicUrl: 'http://127.0.0.1:8088' })).toBeNull();
    expect(warning({ host: 'localhost', publicUrl: 'http://localhost:8088' })).toBeNull();
    expect(warning({ host: '::1', publicUrl: 'http://[::1]:8088' })).toBeNull();
  });
});
