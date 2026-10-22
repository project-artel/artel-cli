import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runServerStart } from '../src/commands/server/start.js';
import { findFreePort } from '../src/server/ports.js';
import { pinnedHttpsRequest } from '../src/server/http-probe.js';
import {
  CONTROL_PATH,
  CONTROL_STOP_PATH,
  CONTROL_TOKEN_HEADER,
  startProxy,
  type RunningProxy,
} from '../src/server/proxy.js';
import { isPidAlive, readState, removeState, writeState } from '../src/server/state-file.js';
import {
  startStackWithInternals,
  stopStackWithInternals,
  type OwnedStack,
  type SupervisorEvent,
  type SupervisorInternals,
} from '../src/server/supervisor.js';
import { readStackSettings, writeStackSettings } from '../src/supervisor.js';
import { createMemorySink } from './helpers.js';
import { createFakeRuntime, waitFor, type FakeRuntime } from './server-helpers.js';
import { canMakeCertificates, makeCertificate, type TestCertificate } from './tls-helpers.js';

const runnable = canMakeCertificates && process.platform !== 'win32' ? describe : describe.skip;

const internals: SupervisorInternals = {
  timeouts: {
    postgresReadyMs: 10_000,
    orchestrationReadyMs: 10_000,
    agentServerReadyMs: 10_000,
    attachMs: 5_000,
    stopGraceMs: 3_000,
  },
};

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function httpsGet(url: string, ca: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    https
      .get(url, { ca }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      })
      .on('error', reject);
  });
}

runnable('proxy over HTTPS', () => {
  let dir: string;
  let certificate: TestCertificate;
  let upstream: http.Server;
  let upstreamPort: number;
  let proxy: RunningProxy;
  let sse: http.ServerResponse | null = null;
  const upgraded = new Set<net.Socket>();

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'artel-tls-proxy-'));
    certificate = await makeCertificate(dir, 'proxy');
    await fs.writeFile(path.join(dir, 'index.html'), '<html>console</html>');
    upstream = http.createServer((req, res) => {
      if (req.url === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: first\n\n');
        sse = res;
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ headers: req.headers }));
    });
    upstream.on('upgrade', (req: http.IncomingMessage, socket: net.Socket) => {
      upgraded.add(socket);
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Seen-Proto: ${String(req.headers['x-forwarded-proto'])}\r\n\r\n`,
      );
      socket.on('data', (chunk: Buffer) => socket.write(`echo:${chunk.toString('utf8')}`));
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamPort = (upstream.address() as net.AddressInfo).port;
    proxy = await startProxy({
      host: '127.0.0.1',
      port: 0,
      orchestrationPort: upstreamPort,
      homeDir: dir,
      tls: {
        cert: await fs.readFile(certificate.certFile),
        key: await fs.readFile(certificate.keyFile),
      },
    });
  });

  afterEach(async () => {
    await proxy.close();
    for (const socket of upgraded) socket.destroy();
    upgraded.clear();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('serves home and forwards /api with X-Forwarded-Proto https', async () => {
    const base = `https://127.0.0.1:${String(proxy.port)}`;
    const home = await httpsGet(`${base}/some/route`, certificate.cert);
    expect(home.status).toBe(200);
    expect(home.body).toContain('console');

    const api = await httpsGet(`${base}/api/projects`, certificate.cert);
    const seen = (JSON.parse(api.body) as { headers: Record<string, string> }).headers;
    expect(seen['x-forwarded-proto']).toBe('https');
    expect(seen['x-forwarded-port']).toBe(String(proxy.port));
  });

  it('refuses a plain http request on the TLS port', async () => {
    const result = await new Promise<string>((resolve) => {
      http
        .get(`http://127.0.0.1:${String(proxy.port)}/`, () => resolve('answered'))
        .on('error', () => resolve('failed'));
    });
    expect(result).toBe('failed');
  });

  it('streams server-sent events over HTTPS', async () => {
    const received: string[] = [];
    const done = new Promise<void>((resolve, reject) => {
      https
        .get(
          `https://127.0.0.1:${String(proxy.port)}/api/events`,
          { ca: certificate.cert },
          (response) => {
            response.setEncoding('utf8');
            response.on('data', (chunk: string) => {
              received.push(chunk);
              if (received.length === 1) sse?.end('data: second\n\n');
            });
            response.on('end', resolve);
          },
        )
        .on('error', reject);
    });
    await done;
    expect(received.join('')).toBe('data: first\n\ndata: second\n\n');
  });

  it('upgrades a WebSocket connection and relays frames both ways', async () => {
    const socket = tls.connect({
      host: '127.0.0.1',
      port: proxy.port,
      ca: certificate.cert,
    });
    const chunks: string[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
    await new Promise<void>((resolve) => socket.once('secureConnect', () => resolve()));
    socket.write(
      `GET /ws/qa HTTP/1.1\r\nHost: 127.0.0.1:${String(proxy.port)}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
    await waitFor(() => chunks.join('').includes('\r\n\r\n'));
    expect(chunks.join('')).toContain('101 Switching Protocols');
    expect(chunks.join('')).toContain('X-Seen-Proto: https');
    socket.write('ping');
    await waitFor(() => chunks.join('').includes('echo:ping'));
    socket.destroy();
  });
});

runnable('control path over HTTPS', () => {
  let dir: string;
  let certificate: TestCertificate;
  let other: TestCertificate;
  let proxies: RunningProxy[];
  let holder: ChildProcess | null;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'artel-tls-control-'));
    certificate = await makeCertificate(dir, 'control');
    other = await makeCertificate(dir, 'other');
    proxies = [];
    holder = null;
  });

  afterEach(async () => {
    holder?.kill();
    for (const proxy of proxies) await proxy.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function tlsProxy(
    cert: TestCertificate,
    control: { pid: number; onStopRequested(): void },
  ): Promise<RunningProxy> {
    const proxy = await startProxy({
      host: '127.0.0.1',
      port: 0,
      orchestrationPort: 1,
      homeDir: dir,
      tls: { cert: await fs.readFile(cert.certFile), key: await fs.readFile(cert.keyFile) },
      control: { token: 'secret-token', runtimeVersion: '0.1.0', ...control },
    });
    proxies.push(proxy);
    return proxy;
  }

  async function fingerprint(cert: TestCertificate): Promise<string> {
    const { X509Certificate } = await import('node:crypto');
    return new X509Certificate(cert.cert).fingerprint256;
  }

  it('answers a request whose peer certificate matches the pinned fingerprint', async () => {
    const proxy = await tlsProxy(certificate, { pid: 4242, onStopRequested: () => undefined });
    const reply = await pinnedHttpsRequest(
      { host: '127.0.0.1', port: proxy.port },
      { method: 'GET', path: CONTROL_PATH, fingerprint: await fingerprint(certificate) },
    );
    expect(reply?.status).toBe(200);
    expect(JSON.parse(reply?.body ?? '{}')).toMatchObject({ pid: 4242 });
  });

  it('sends nothing, token included, to a peer with another certificate', async () => {
    const stops: number[] = [];
    const proxy = await tlsProxy(other, { pid: 1, onStopRequested: () => stops.push(1) });
    const reply = await pinnedHttpsRequest(
      { host: '127.0.0.1', port: proxy.port },
      {
        method: 'POST',
        path: CONTROL_STOP_PATH,
        headers: { [CONTROL_TOKEN_HEADER]: 'secret-token' },
        fingerprint: await fingerprint(certificate),
      },
    );
    expect(reply).toBeNull();
    expect(stops).toEqual([]);
  });

  it('stopStack reaches a supervisor in another process over HTTPS using state.json', async () => {
    holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    const pid = holder.pid ?? 0;
    const dataDir = path.join(dir, 'data');
    const stateFile = path.join(dataDir, 'state.json');
    const stopped: string[] = [];
    const proxy = await tlsProxy(certificate, {
      pid,
      onStopRequested: () => {
        stopped.push('requested');
        holder?.kill();
        void removeState(stateFile);
      },
    });
    await fs.mkdir(dataDir, { recursive: true });
    await writeState(stateFile, {
      schemaVersion: 1,
      supervisorPid: pid,
      url: `https://127.0.0.1:${String(proxy.port)}`,
      host: '127.0.0.1',
      proxyPort: proxy.port,
      runtimeDir: dir,
      runtimeVersion: '0.1.0',
      startedAt: new Date().toISOString(),
      controlToken: 'secret-token',
      tlsFingerprint: await fingerprint(certificate),
      pids: { postgres: null, orchestration: null, 'agent-server': null, proxy: pid },
      services: {
        postgres: 'ready',
        orchestration: 'ready',
        'agent-server': 'ready',
        proxy: 'ready',
      },
    });

    await stopStackWithInternals({ dataDir }, internals);

    expect(stopped).toEqual(['requested']);
    expect(await readState(stateFile)).toBeNull();
    await waitFor(() => !isPidAlive(pid));
  });
});

runnable('supervisor with TLS settings', () => {
  let runtime: FakeRuntime;
  let certificate: TestCertificate;
  let events: SupervisorEvent[];
  let stacks: OwnedStack[];

  beforeEach(async () => {
    runtime = await createFakeRuntime();
    certificate = await makeCertificate(path.join(runtime.root, 'tls'), 'stack');
    events = [];
    stacks = [];
  });

  afterEach(async () => {
    for (const stack of stacks) await stack.stop();
    await runtime.cleanup();
  });

  async function start(extra: Record<string, unknown> = {}): Promise<OwnedStack> {
    const stack = await startStackWithInternals(
      {
        runtimeDir: runtime.runtimeDir,
        dataDir: runtime.dataDir,
        onEvent: (event) => events.push(event),
        ...extra,
      },
      internals,
    );
    stacks.push(stack);
    return stack;
  }

  async function orchestrationEnv(): Promise<Record<string, string>> {
    return JSON.parse(
      await fs.readFile(path.join(runtime.root, 'orchestration-env.json'), 'utf8'),
    ) as Record<string, string>;
  }

  it('serves https, marks the cookie Secure and tells orchestration its own address', async () => {
    const stack = await start({
      tls: { certFile: certificate.certFile, keyFile: certificate.keyFile },
    });

    expect(stack.url).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/);
    const api = await httpsGet(`${stack.url}/api/projects`, certificate.cert);
    const seen = (JSON.parse(api.body) as { headers: Record<string, string> }).headers;
    expect(seen['x-forwarded-proto']).toBe('https');

    const env = await orchestrationEnv();
    const config = JSON.parse(
      await fs.readFile(path.join(runtime.dataDir, 'config.json'), 'utf8'),
    ) as { ports: { orchestration: number } };
    expect(env.ARTEL_SECURE_COOKIE).toBe('true');
    expect(env.ARTEL_INTERNAL_BASE_URL).toBe(
      `http://127.0.0.1:${String(config.ports.orchestration)}`,
    );
    expect(env.ARTEL_HOME_URL).toBe(stack.url);
    expect(env.ARTEL_ALLOWED_ORIGINS).toBe(stack.url);

    const state = await readState(path.join(runtime.dataDir, 'state.json'));
    expect(state?.tlsFingerprint).toMatch(/^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/);
  });

  it('keeps the cookie non-Secure on http and still passes the internal base URL', async () => {
    await start();
    const env = await orchestrationEnv();
    expect(env.ARTEL_SECURE_COOKIE).toBe('false');
    expect(env.ARTEL_INTERNAL_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('marks the cookie Secure for an https public URL in front of plain http, such as a tunnel', async () => {
    await start({ publicUrl: 'https://artel.example.com' });
    const env = await orchestrationEnv();
    expect(env.ARTEL_SECURE_COOKIE).toBe('true');
    expect(env.ARTEL_HOME_URL).toBe('https://artel.example.com');
  });

  it('saves explicit options and reads them back as the next defaults', async () => {
    const first = await start({
      tls: { certFile: certificate.certFile, keyFile: certificate.keyFile },
      host: '127.0.0.1',
    });
    const port = Number(new URL(first.url).port);
    await first.stop();
    expect(await readStackSettings({ dataDir: runtime.dataDir })).toEqual({
      host: '127.0.0.1',
      port,
      publicUrl: `https://127.0.0.1:${String(port)}`,
      tls: { certFile: certificate.certFile, keyFile: certificate.keyFile },
    });

    // 명시하지 않았으므로 config.json 의 TLS 로 다시 뜬다.
    const second = await start();
    expect(second.url).toBe(`https://127.0.0.1:${String(port)}`);
    await second.stop();

    // 명시한 값이 config.json 보다 앞선다.
    const third = await start({ tls: null });
    expect(third.url.startsWith('http://')).toBe(true);
    expect((await readStackSettings({ dataDir: runtime.dataDir })).tls).toBeNull();
  });

  it('uses what writeStackSettings saved on the next start', async () => {
    await writeStackSettings(
      { tls: { certFile: certificate.certFile, keyFile: certificate.keyFile } },
      { dataDir: runtime.dataDir },
    );
    const stack = await start();
    expect(stack.url.startsWith('https://')).toBe(true);
  });

  it('rejects an http public URL with TLS before it starts any service', async () => {
    await expect(
      start({
        tls: { certFile: certificate.certFile, keyFile: certificate.keyFile },
        publicUrl: 'http://127.0.0.1:8088',
      }),
    ).rejects.toMatchObject({ code: 'server_settings_invalid' });
    expect(await runtime.records()).toEqual([]);
  });

  it('emits a warning when a non-loopback host serves plain http, and not otherwise', async () => {
    const stack = await start({ host: '0.0.0.0', port: await findFreePort() });
    const warnings = events.filter((event) => event.type === 'warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ code: 'plain_text_exposure' });
    await stack.stop();

    events.length = 0;
    await start({ host: '127.0.0.1', port: await findFreePort() });
    expect(events.some((event) => event.type === 'warning')).toBe(false);
  });

  it('prints the plain-text warning in the CLI and puts it in the --json payload', async () => {
    const xdg = path.join(runtime.root, 'xdg');
    const env = { XDG_DATA_HOME: xdg, HOME: xdg, ARTEL_RUNTIME_DIR: runtime.runtimeDir };
    const sink = createMemorySink();
    const running = runServerStart(
      { json: true, foreground: true, install: false, host: '0.0.0.0', port: await findFreePort() },
      sink,
      env,
    );
    await waitFor(() => sink.stdout.length > 0, 20_000);
    const payload = sink.lastJson<{ warnings: string[] }>();
    expect(payload.warnings).toHaveLength(1);
    expect(payload.warnings[0]).toContain('passwords and session cookies');
    await stopStackWithInternals({ dataDir: path.join(xdg, 'artel') }, { env });
    await running;
  }, 30_000);
});
