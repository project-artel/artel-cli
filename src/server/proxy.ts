import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import type { Duplex } from 'node:stream';

/** orchestration 으로 넘기는 경로. `deploy/Caddyfile` 이 orchestration 으로 보내는 것과 같다. */
export const PROXIED_PREFIXES = ['/api', '/oauth2', '/login/oauth2', '/ws'] as const;

/** supervisor 자신이 답하는 경로. home 의 파일 이름과 겹치지 않도록 `__` 로 시작한다. */
export const CONTROL_PATH = '/__artel/supervisor';
export const CONTROL_STOP_PATH = `${CONTROL_PATH}/stop`;
export const CONTROL_TOKEN_HEADER = 'x-artel-control-token';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
};

export function contentTypeFor(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

export function isProxiedPath(pathname: string): boolean {
  return PROXIED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/** 요청과 응답 어느 쪽에서도 다음 hop 으로 넘기지 않는 header. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export interface ProxyControl {
  pid: number;
  token: string;
  runtimeVersion: string;
  onStopRequested(): void;
}

export interface ProxyOptions {
  host: string;
  port: number;
  /** orchestration 의 공개 port. 언제나 `127.0.0.1` 에 있다. */
  orchestrationPort: number;
  homeDir: string;
  control?: ProxyControl;
  onError?: (message: string) => void;
}

export interface RunningProxy {
  port: number;
  close(): Promise<void>;
}

function pathnameOf(url: string | undefined): string {
  try {
    return new URL(url ?? '/', 'http://proxy.invalid').pathname;
  } catch {
    return '/';
  }
}

/**
 * orchestration 은 `forward-headers-strategy: framework` 라 이 header 로 자기 공개 주소를 안다.
 * 앞에 TLS 를 끝내는 proxy 가 따로 있으면 그쪽이 붙인 값을 그대로 둔다.
 */
function forwardedHeaders(req: http.IncomingMessage): Record<string, string> {
  const remote = req.socket.remoteAddress ?? '';
  const previousFor = req.headers['x-forwarded-for'];
  const host = req.headers.host ?? '';
  const existingProto = req.headers['x-forwarded-proto'];
  const existingHost = req.headers['x-forwarded-host'];
  const existingPort = req.headers['x-forwarded-port'];
  const proto = typeof existingProto === 'string' ? existingProto : 'http';
  const hostPort = /:(\d+)$/.exec(host)?.[1];
  return {
    'x-forwarded-for': typeof previousFor === 'string' ? `${previousFor}, ${remote}` : remote,
    'x-forwarded-proto': proto,
    'x-forwarded-host': typeof existingHost === 'string' ? existingHost : host,
    'x-forwarded-port':
      typeof existingPort === 'string'
        ? existingPort
        : (hostPort ?? (proto === 'https' ? '443' : '80')),
  };
}

function upstreamRequestHeaders(req: http.IncomingMessage): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    headers[name] = value;
  }
  return { ...headers, ...forwardedHeaders(req) };
}

function forwardHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  orchestrationPort: number,
  agent: http.Agent,
  onError: (message: string) => void,
): void {
  const upstream = http.request(
    {
      host: '127.0.0.1',
      port: orchestrationPort,
      method: req.method,
      path: req.url,
      headers: upstreamRequestHeaders(req),
      agent,
    },
    (upstreamRes) => {
      const headers: http.OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (value === undefined || HOP_BY_HOP.has(name)) continue;
        headers[name] = value;
      }
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, headers);
      // Server-Sent Events 는 첫 event 전에 header 가 먼저 가야 browser 가 stream 을 연다.
      res.flushHeaders();
      upstreamRes.pipe(res);
    },
  );
  upstream.on('error', (error) => {
    onError(`${req.method ?? 'GET'} ${req.url ?? '/'} -> orchestration failed: ${error.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('ARTEL orchestration is not reachable.\n');
    } else {
      res.destroy();
    }
  });
  // browser 가 SSE 를 닫으면 orchestration 쪽 연결도 닫는다.
  res.on('close', () => {
    if (!res.writableFinished) upstream.destroy();
  });
  req.pipe(upstream);
}

function forwardUpgrade(
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  orchestrationPort: number,
  onError: (message: string) => void,
): void {
  const upstream = net.connect(orchestrationPort, '127.0.0.1');
  const fail = (error: Error): void => {
    onError(`upgrade ${req.url ?? '/'} -> orchestration failed: ${error.message}`);
    socket.destroy();
    upstream.destroy();
  };
  upstream.once('error', fail);
  socket.once('error', () => upstream.destroy());
  // 한쪽이 닫히면 다른 쪽도 닫는다. 남겨 두면 proxy 를 닫은 뒤에도 orchestration 쪽 연결이 산다.
  socket.once('close', () => upstream.destroy());
  upstream.once('close', () => socket.destroy());
  upstream.once('connect', () => {
    const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/${req.httpVersion}`];
    const forwarded = forwardedHeaders(req);
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      const name = req.rawHeaders[index] ?? '';
      const lower = name.toLowerCase();
      if (lower in forwarded) continue;
      lines.push(`${name}: ${req.rawHeaders[index + 1] ?? ''}`);
    }
    for (const [name, value] of Object.entries(forwarded)) lines.push(`${name}: ${value}`);
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
}

function sendFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  file: string,
  size: number,
): void {
  const cacheControl = /[\\/]assets[\\/]/.test(file)
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';
  res.writeHead(200, {
    'content-type': contentTypeFor(file),
    'content-length': size,
    'cache-control': cacheControl,
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(file).pipe(res);
}

function statFile(file: string): fs.Stats | null {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

/**
 * `home/` 에서 파일을 찾고, 없으면 `index.html` 을 준다. 화면 route 는 artel-home 의 router 가
 * 처리하므로 모르는 경로도 404 가 아니라 `index.html` 이다.
 */
function serveHome(req: http.IncomingMessage, res: http.ServerResponse, homeDir: string): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' });
    res.end();
    return;
  }
  const root = path.resolve(homeDir);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathnameOf(req.url));
  } catch {
    decoded = '/';
  }
  const candidate = path.resolve(root, `.${path.posix.normalize(decoded)}`);
  const inside = candidate === root || candidate.startsWith(`${root}${path.sep}`);
  if (inside && !decoded.includes('\0')) {
    const stat = statFile(candidate);
    if (stat?.isFile()) {
      sendFile(req, res, candidate, stat.size);
      return;
    }
    if (stat?.isDirectory()) {
      const indexFile = path.join(candidate, 'index.html');
      const indexStat = statFile(indexFile);
      if (indexStat?.isFile()) {
        sendFile(req, res, indexFile, indexStat.size);
        return;
      }
    }
  }
  const fallback = path.join(root, 'index.html');
  const fallbackStat = statFile(fallback);
  if (!fallbackStat?.isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found\n');
    return;
  }
  sendFile(req, res, fallback, fallbackStat.size);
}

function tokenMatches(expected: string, given: string | string[] | undefined): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function handleControl(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  control: ProxyControl | undefined,
): boolean {
  const pathname = pathnameOf(req.url);
  if (pathname === CONTROL_PATH && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        pid: control?.pid ?? process.pid,
        runtimeVersion: control?.runtimeVersion ?? null,
      }),
    );
    return true;
  }
  if (pathname === CONTROL_STOP_PATH && req.method === 'POST') {
    if (control === undefined || !tokenMatches(control.token, req.headers[CONTROL_TOKEN_HEADER])) {
      res.writeHead(403);
      res.end();
      return true;
    }
    res.writeHead(202);
    res.end();
    // 응답을 다 보낸 뒤에 멈춘다. proxy 가 먼저 닫히면 요청한 쪽은 실패로 본다.
    res.on('finish', () => control.onStopRequested());
    return true;
  }
  return false;
}

/** 한 origin 으로 console 과 API 를 함께 내는 reverse proxy. Caddy 가 compose 에서 하던 일이다. */
export function startProxy(options: ProxyOptions): Promise<RunningProxy> {
  const onError = options.onError ?? (() => undefined);
  const agent = new http.Agent({ keepAlive: true });
  const sockets = new Set<Duplex>();

  const server = http.createServer((req, res) => {
    if (handleControl(req, res, options.control)) return;
    if (isProxiedPath(pathnameOf(req.url))) {
      forwardHttp(req, res, options.orchestrationPort, agent, onError);
      return;
    }
    serveHome(req, res, options.homeDir);
  });
  // 문서 upload 와 SSE 는 몇 분씩 걸린다. Node 의 기본 요청 시간 상한(300 초)을 끈다.
  server.requestTimeout = 0;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    if (!isProxiedPath(pathnameOf(req.url))) {
      socket.destroy();
      return;
    }
    forwardUpgrade(req, socket, head, options.orchestrationPort, onError);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : options.port;
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            for (const socket of sockets) socket.destroy();
            agent.destroy();
          }),
      });
    });
  });
}
