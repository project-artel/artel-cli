import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { SDK_TOKEN_MINT_PATH } from '../src/http/client.js';
import type { GameInstance } from '../src/http/gameInstances.js';
import type { GameProcessSpawner, SpawnedGameProcess } from '../src/game/process.js';
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

export interface SdkTokenMintCall {
  authorization: string | null;
}

export interface GameInstanceListCall {
  authorization: string | null;
  projectId: string;
}

export interface FakeGameServerOptions {
  sdkToken: string;
  /** 준 값이 없으면 SDK token mint 를 404 로 답한다(`sdk_token_not_supported` 경로 검증용). */
  mintNotSupported?: boolean;
  /** `game-instances` 목록 GET 호출마다 순서대로 하나씩 꺼내 쓴다. 소진되면 마지막 값을 반복한다. */
  instanceSequence: readonly (readonly GameInstance[])[];
}

export interface FakeGameServer {
  baseUrl: string;
  mintCalls: SdkTokenMintCall[];
  listCalls: GameInstanceListCall[];
  close(): Promise<void>;
}

/**
 * orchestration 서버 흉내. `mintSdkToken` 과 `listGameInstances` 가 실제로 부르는 두 경로만
 * 답한다. `game-instances` 목록은 폴링할 때마다 다음 snapshot 을 내주므로, 등록이 몇 번째
 * polling 에 나타나는지를 테스트가 정확히 통제할 수 있다.
 */
export async function startFakeGameServer(options: FakeGameServerOptions): Promise<FakeGameServer> {
  const mintCalls: SdkTokenMintCall[] = [];
  const listCalls: GameInstanceListCall[] = [];
  let listCallCount = 0;

  const server = http.createServer((request, response) => {
    const authorization = request.headers.authorization ?? null;
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');

    if (request.method === 'POST' && url.pathname === SDK_TOKEN_MINT_PATH) {
      mintCalls.push({ authorization });
      if (options.mintNotSupported === true) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end('{"code":"not_found","message":"no such endpoint"}');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          token: options.sdkToken,
          expiresAt: null,
          refreshToken: 'refresh_token_value',
          refreshExpiresAt: null,
          userId: 'user-1',
          displayName: 'Test User',
        }),
      );
      return;
    }

    const projectMatch = /^\/api\/projects\/([^/]+)\/game-instances$/.exec(url.pathname);
    if (request.method === 'GET' && projectMatch !== null) {
      const projectId = decodeURIComponent(projectMatch[1] ?? '');
      listCalls.push({ authorization, projectId });
      const index = Math.min(listCallCount, options.instanceSequence.length - 1);
      const items = options.instanceSequence[index] ?? [];
      listCallCount += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ items }));
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json' });
    response.end('{"code":"not_found","message":"no such route"}');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the fake game server did not bind to a TCP port');
  }

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    mintCalls,
    listCalls,
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

export interface FakeSpawnCall {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface FakeSpawnedProcess extends SpawnedGameProcess {
  /** 테스트가 자식이 (일찍) 죽었다고 알리는 손잡이. */
  fireExit(code: number | null, signal: NodeJS.Signals | null): void;
  killCalls: (NodeJS.Signals | undefined)[];
}

export interface FakeSpawner {
  spawn: GameProcessSpawner;
  calls: FakeSpawnCall[];
  processes: FakeSpawnedProcess[];
  /** 다음 한 번의 spawn 호출만 이 에러로 실패시킨다. */
  failNext(error: Error & { code?: string }): void;
}

/** 실제 게임을 띄우지 않고 `game start`/`game logout` 을 테스트하는 손잡이. */
export function createFakeSpawner(pid = 4242): FakeSpawner {
  const calls: FakeSpawnCall[] = [];
  const processes: FakeSpawnedProcess[] = [];
  let pendingFailure: (Error & { code?: string }) | null = null;

  const spawn: GameProcessSpawner = (command, args, env) => {
    calls.push({ command, args: [...args], env });

    if (pendingFailure !== null) {
      const failure = pendingFailure;
      pendingFailure = null;
      return Promise.reject(failure);
    }

    const listeners: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
    const killCalls: (NodeJS.Signals | undefined)[] = [];
    const proc: FakeSpawnedProcess = {
      pid,
      onExit(listener) {
        listeners.push(listener);
      },
      kill(signal) {
        killCalls.push(signal);
      },
      fireExit(code, signal) {
        for (const listener of listeners) {
          listener(code, signal);
        }
      },
      killCalls,
    };
    processes.push(proc);
    return Promise.resolve(proc);
  };

  return {
    spawn,
    calls,
    processes,
    failNext(error) {
      pendingFailure = error;
    },
  };
}

/** 고정 sleep 대신 조건이 참이 될 때까지 짧은 간격으로 다시 확인한다. */
export async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2_000,
  intervalMs = 5,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('waitUntil: condition was never met');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
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
