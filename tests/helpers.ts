import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import type { OutputSink } from '../src/output/envelope.js';

export interface MemorySink extends OutputSink {
  readonly stdout: string[];
  readonly stderr: string[];
  everything(): string;
  lastJson<T>(): T;
}

export function createMemorySink(): MemorySink {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    out(line) {
      stdout.push(line);
    },
    err(line) {
      stderr.push(line);
    },
    everything() {
      return [...stdout, ...stderr].join('\n');
    },
    lastJson<T>(): T {
      const line = stdout.at(-1);
      if (line === undefined) {
        throw new Error('nothing was written to stdout');
      }
      return JSON.parse(line) as T;
    },
  };
}

export interface TempConfig {
  root: string;
  /** 아직 만들어지지 않은 디렉터리다. 0700 으로 만들어지는지 확인하려면 이래야 한다. */
  configDir: string;
  credentialsFile: string;
  cleanup(): Promise<void>;
}

export async function createTempConfig(): Promise<TempConfig> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'artel-cli-test-'));
  const configDir = path.join(root, 'artel');
  return {
    root,
    configDir,
    credentialsFile: path.join(configDir, 'credentials.json'),
    async cleanup() {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

export async function modeOf(file: string): Promise<string> {
  const stats = await fs.stat(file);
  return (stats.mode & 0o7777).toString(8).padStart(4, '0');
}

export interface ExchangeRecord {
  code: string;
  codeVerifier: string;
  name: string;
  expiresInDays: number | null;
}

export interface FakeOrchestration {
  baseUrl: string;
  exchanges: ExchangeRecord[];
  close(): Promise<void>;
}

export interface FakeOrchestrationOptions {
  /** 이 code 만 받아 준다. */
  expectedCode: string;
  /** verifier 를 다시 해시해 이 challenge 와 맞는지 확인한다. 브라우저가 URL 을 받은
   *  뒤에야 값이 정해지므로 getter 로 받는다. */
  expectedChallenge: () => string;
  token: string;
  /** 주면 exchange 가 이 status 와 body 로 실패한다. */
  failWith?: { status: number; body: string };
}

/**
 * orchestration 서버 흉내. mocking 라이브러리를 끌어오지 않고 진짜 loopback HTTP 를 쓴다.
 * 받은 `codeVerifier` 로 SHA-256 을 다시 계산해 앞서 브라우저에 실린 challenge 와 맞는지
 * 확인하므로 PKCE 왕복이 끝에서 끝까지 검증된다.
 */
export async function startFakeOrchestration(
  options: FakeOrchestrationOptions,
): Promise<FakeOrchestration> {
  const exchanges: ExchangeRecord[] = [];

  const server = http.createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/api/auth/cli-tokens/exchange') {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"code":"not_found","message":"no such endpoint"}');
      return;
    }

    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (options.failWith !== undefined) {
        response.writeHead(options.failWith.status, { 'content-type': 'application/json' });
        response.end(options.failWith.body);
        return;
      }

      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ExchangeRecord;
      exchanges.push(body);

      const challenge = crypto
        .createHash('sha256')
        .update(body.codeVerifier, 'utf8')
        .digest('base64url');
      if (body.code !== options.expectedCode || challenge !== options.expectedChallenge()) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end('{"code":"invalid_grant","message":"code or verifier did not match"}');
        return;
      }

      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: '01JXTOKENID',
          name: body.name,
          token: options.token,
          createdAt: '2026-09-03T04:11:07Z',
          expiresAt: body.expiresInDays === null ? null : '2026-12-02T04:11:07Z',
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the fake orchestration server did not bind to a TCP port');
  }

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    exchanges,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    },
  };
}

/** 브라우저 대신 loopback 콜백을 직접 친다. */
export async function callBack(
  port: number,
  query: Record<string, string>,
  overrides: { path?: string; method?: string; host?: string } = {},
): Promise<{ status: number; body: string }> {
  const search = new URLSearchParams(query).toString();
  const target = `${overrides.path ?? '/callback'}${search.length > 0 ? `?${search}` : ''}`;

  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        method: overrides.method ?? 'GET',
        path: target,
        headers: { host: overrides.host ?? `127.0.0.1:${String(port)}` },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    request.on('error', reject);
    request.end();
  });
}

export function relayQuery(url: string): {
  challenge: string;
  port: number;
  state: string;
  kind: string | null;
} {
  const parsed = new URL(url);
  return {
    challenge: parsed.searchParams.get('challenge') ?? '',
    port: Number.parseInt(parsed.searchParams.get('port') ?? '0', 10),
    state: parsed.searchParams.get('state') ?? '',
    kind: parsed.searchParams.get('kind'),
  };
}
