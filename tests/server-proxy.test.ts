import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONTROL_STOP_PATH,
  CONTROL_TOKEN_HEADER,
  isProxiedPath,
  startProxy,
  type RunningProxy,
} from '../src/server/proxy.js';

interface Upstream {
  port: number;
  /** SSE 를 이어 갈지 정한다. 테스트가 첫 event 를 받은 뒤 두 번째를 보낸다. */
  sendSecondEvent(): void;
  close(): Promise<void>;
}

/** orchestration 대신 쓰는 upstream. 받은 요청을 JSON 으로 돌려주고, SSE 와 upgrade 를 흉내 낸다. */
function startUpstream(): Promise<Upstream> {
  let pendingSse: http.ServerResponse | null = null;
  const upgraded = new Set<net.Socket>();
  const server = http.createServer((req, res) => {
    if (req.url === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('data: first\n\n');
      pendingSse = res;
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      res.writeHead(201, { 'content-type': 'application/json', 'x-upstream': 'yes' });
      res.end(
        JSON.stringify({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
  });
  server.on('upgrade', (req: http.IncomingMessage, socket: net.Socket) => {
    upgraded.add(socket);
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Seen-Proto: ${String(req.headers['x-forwarded-proto'])}\r\n\r\n`,
    );
    socket.on('data', (chunk: Buffer) => socket.write(`echo:${chunk.toString('utf8')}`));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo;
      resolve({
        port: address.port,
        sendSecondEvent() {
          pendingSse?.end('data: second\n\n');
        },
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            for (const socket of upgraded) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

describe('isProxiedPath', () => {
  it('sends the four prefixes to orchestration and nothing else', () => {
    for (const pathname of [
      '/api',
      '/api/projects',
      '/oauth2/authorization/github',
      '/login/oauth2/code/github',
      '/ws/qa',
    ]) {
      expect(isProxiedPath(pathname)).toBe(true);
    }
    for (const pathname of ['/', '/apiary', '/login', '/assets/app.js', '/wsx']) {
      expect(isProxiedPath(pathname)).toBe(false);
    }
  });
});

describe('proxy', () => {
  let upstream: Upstream;
  let proxy: RunningProxy;
  let homeDir: string;
  let base: string;
  const stopRequests: number[] = [];

  beforeEach(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'artel-proxy-'));
    await fs.mkdir(path.join(homeDir, 'assets'));
    await fs.writeFile(path.join(homeDir, 'index.html'), '<html>console</html>');
    await fs.writeFile(path.join(homeDir, 'assets', 'app.js'), 'console.log(1)');
    await fs.writeFile(path.join(homeDir, 'assets', 'style.css'), 'body{}');
    await fs.writeFile(path.join(homeDir, 'logo.svg'), '<svg/>');
    upstream = await startUpstream();
    proxy = await startProxy({
      host: '127.0.0.1',
      port: 0,
      orchestrationPort: upstream.port,
      homeDir,
      control: {
        pid: 4242,
        token: 'secret-token',
        runtimeVersion: '0.1.0',
        onStopRequested: () => stopRequests.push(Date.now()),
      },
    });
    base = `http://127.0.0.1:${String(proxy.port)}`;
  });

  afterEach(async () => {
    await proxy.close();
    await upstream.close();
    await fs.rm(homeDir, { recursive: true, force: true });
    stopRequests.length = 0;
  });

  it('forwards /api with method, body, Host and X-Forwarded-* headers', async () => {
    const response = await fetch(`${base}/api/projects?page=1`, {
      method: 'POST',
      body: 'hello',
      headers: { 'content-type': 'text/plain' },
    });
    expect(response.status).toBe(201);
    expect(response.headers.get('x-upstream')).toBe('yes');
    const seen = (await response.json()) as {
      method: string;
      url: string;
      body: string;
      headers: Record<string, string>;
    };
    expect(seen.method).toBe('POST');
    expect(seen.url).toBe('/api/projects?page=1');
    expect(seen.body).toBe('hello');
    expect(seen.headers.host).toBe(`127.0.0.1:${String(proxy.port)}`);
    expect(seen.headers['x-forwarded-proto']).toBe('http');
    expect(seen.headers['x-forwarded-host']).toBe(`127.0.0.1:${String(proxy.port)}`);
    expect(seen.headers['x-forwarded-port']).toBe(String(proxy.port));
    expect(seen.headers['x-forwarded-for']).toContain('127.0.0.1');
  });

  it('streams server-sent events without waiting for the upstream to finish', async () => {
    const response = await fetch(`${base}/api/events`);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const reader = (response.body as ReadableStream<Uint8Array> | null)?.getReader();
    if (reader === undefined) throw new Error('no body');
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('data: first\n\n');
    upstream.sendSecondEvent();
    let rest = '';
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      rest += new TextDecoder().decode(chunk.value);
    }
    expect(rest).toBe('data: second\n\n');
  });

  it('passes a WebSocket upgrade through in both directions', async () => {
    const socket = net.connect(proxy.port, '127.0.0.1');
    await new Promise((resolve) => socket.once('connect', resolve));
    socket.write(
      'GET /ws/qa HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    );
    const handshake = await new Promise<string>((resolve) =>
      socket.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8'))),
    );
    expect(handshake).toMatch(/^HTTP\/1\.1 101/);
    expect(handshake).toContain('X-Seen-Proto: http');
    socket.write('ping');
    const echoed = await new Promise<string>((resolve) =>
      socket.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8'))),
    );
    expect(echoed).toBe('echo:ping');
    socket.destroy();
  });

  it('closes an upgrade outside the proxied prefixes', async () => {
    const socket = net.connect(proxy.port, '127.0.0.1');
    await new Promise((resolve) => socket.once('connect', resolve));
    socket.write(
      'GET /other HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    );
    await new Promise((resolve) => socket.once('close', resolve));
  });

  it('serves home files with their content types', async () => {
    const js = await fetch(`${base}/assets/app.js`);
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(js.headers.get('cache-control')).toContain('immutable');
    expect(await js.text()).toBe('console.log(1)');
    expect((await fetch(`${base}/assets/style.css`)).headers.get('content-type')).toBe(
      'text/css; charset=utf-8',
    );
    expect((await fetch(`${base}/logo.svg`)).headers.get('content-type')).toBe('image/svg+xml');
    const index = await fetch(`${base}/`);
    expect(index.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(index.headers.get('cache-control')).toBe('no-cache');
  });

  it('falls back to index.html for an unknown route and never leaves home', async () => {
    expect(await (await fetch(`${base}/projects/42/qa`)).text()).toBe('<html>console</html>');
    const traversal = await new Promise<string>((resolve) => {
      http.get(`${base}/%2e%2e/%2e%2e/etc/passwd`, (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
        res.on('end', () => resolve(body));
      });
    });
    expect(traversal).toBe('<html>console</html>');
  });

  it('answers 502 when orchestration is down', async () => {
    await upstream.close();
    const response = await fetch(`${base}/api/projects`);
    expect(response.status).toBe(502);
  });

  it('accepts a stop request only with the control token', async () => {
    const identity = (await (await fetch(`${base}/__artel/supervisor`)).json()) as { pid: number };
    expect(identity.pid).toBe(4242);
    const denied = await fetch(`${base}${CONTROL_STOP_PATH}`, {
      method: 'POST',
      headers: { [CONTROL_TOKEN_HEADER]: 'wrong' },
    });
    expect(denied.status).toBe(403);
    expect(stopRequests).toHaveLength(0);
    const accepted = await fetch(`${base}${CONTROL_STOP_PATH}`, {
      method: 'POST',
      headers: { [CONTROL_TOKEN_HEADER]: 'secret-token' },
    });
    expect(accepted.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stopRequests).toHaveLength(1);
  });
});
