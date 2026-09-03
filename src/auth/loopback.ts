import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { CliError } from '../errors.js';
import { statesMatch } from './pkce.js';

/** relay page 가 `port` 를 이 범위로 검증한다. */
const MIN_PORT = 1024;
const MAX_PORT = 65535;

/**
 * 지나가던 요청 하나가 진짜 로그인을 끊으면 안 되므로 어긋난 요청에는 400/404 를 주고
 * listener 를 살려 둔다. 다만 무한히 받아 주지는 않는다.
 */
const MAX_REJECTED_REQUESTS = 10;

const CALLBACK_PATH = '/callback';

export interface LoopbackListener {
  readonly port: number;
  /** 마감은 이 함수를 부른 시점부터 잰다 — 즉 브라우저를 연 뒤부터다. */
  waitForCode(timeoutMs: number): Promise<string>;
  close(): Promise<void>;
}

interface Deferred {
  promise: Promise<string>;
  resolve: (code: string) => void;
  reject: (error: Error) => void;
}

function createDeferred(): Deferred {
  let resolve!: (code: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // waitForCode 보다 먼저 콜백이 들어와 reject 될 수 있다. 그 사이의 unhandled rejection 을 막는다.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/**
 * `127.0.0.1` 의 OS 가 고른 포트에 붙는다. `0.0.0.0` 이나 `::` 에는 바인드하지 않는다.
 * 고정 포트 후보군은 쓰지 않는다 — 충돌하는 데다 다른 로컬 프로세스가 미리 그 자리를
 * 차지하고 앉을 수 있다.
 */
export async function startLoopbackListener(expectedState: string): Promise<LoopbackListener> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const listener = await bindOnce(expectedState);
    if (listener.port >= MIN_PORT && listener.port <= MAX_PORT) {
      return listener;
    }
    await listener.close();
  }
  throw new CliError(
    'loopback_port',
    `The operating system handed out a port outside ${String(MIN_PORT)}-${String(MAX_PORT)} twice, and the console rejects a callback port outside that range.`,
  );
}

async function bindOnce(expectedState: string): Promise<LoopbackListener> {
  const deferred = createDeferred();
  let rejectedRequests = 0;
  let settled = false;

  const server = http.createServer((request, response) => {
    const outcome = classify(request, expectedState, port);

    if (outcome.kind === 'rejected') {
      respond(response, outcome.status, outcome.body);
      rejectedRequests += 1;
      if (rejectedRequests >= MAX_REJECTED_REQUESTS) {
        finish(() =>
          deferred.reject(
            new CliError(
              'loopback_abuse',
              `The local callback listener refused ${String(MAX_REJECTED_REQUESTS)} unexpected requests, so it stopped waiting. Run "artel auth login" again.`,
            ),
          ),
        );
      }
      return;
    }

    if (outcome.kind === 'denied') {
      respond(
        response,
        200,
        'Sign-in was refused. You can close this tab and return to the terminal.',
      );
      finish(() =>
        deferred.reject(
          new CliError('login_denied', `The console refused the sign-in: ${outcome.reason}.`),
        ),
      );
      return;
    }

    // 응답 본문에 `code` 를 되비추지 않는다.
    respond(response, 200, 'Signed in. You can close this tab and return to the terminal.');
    finish(() => {
      deferred.resolve(outcome.code);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const port = portOf(address);

  const close = async (): Promise<void> => {
    if (!server.listening) {
      return;
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  };

  function finish(settle: () => void): void {
    if (settled) {
      return;
    }
    settled = true;
    settle();
    // 창은 요청 한 번 폭이다.
    void close();
  }

  return {
    port,
    async waitForCode(timeoutMs: number): Promise<string> {
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new CliError(
              'login_timeout',
              `No sign-in callback arrived within ${String(Math.round(timeoutMs / 1000))} seconds. Run "artel auth login" again.`,
            ),
          );
        }, timeoutMs);
      });
      try {
        return await Promise.race([deferred.promise, deadline]);
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        await close();
      }
    },
    close,
  };
}

function portOf(address: string | AddressInfo | null): number {
  if (address === null || typeof address === 'string') {
    throw new CliError(
      'loopback_port',
      'The local callback listener did not bind to a TCP port, so there is nothing for the console to call back to.',
    );
  }
  return address.port;
}

type CallbackOutcome =
  | { kind: 'accepted'; code: string }
  | { kind: 'denied'; reason: string }
  | { kind: 'rejected'; status: number; body: string };

function classify(
  request: http.IncomingMessage,
  expectedState: string,
  port: number,
): CallbackOutcome {
  // 어떤 이름이 127.0.0.1 로 풀리는 DNS rebinding 을 막는다.
  if (request.headers.host !== `127.0.0.1:${String(port)}`) {
    return { kind: 'rejected', status: 400, body: 'Unexpected Host header.' };
  }
  if (request.method !== 'GET') {
    return { kind: 'rejected', status: 404, body: 'Not found.' };
  }

  const url = new URL(request.url ?? '/', `http://127.0.0.1:${String(port)}`);
  if (url.pathname !== CALLBACK_PATH) {
    return { kind: 'rejected', status: 404, body: 'Not found.' };
  }
  if (!statesMatch(expectedState, url.searchParams.get('state'))) {
    return { kind: 'rejected', status: 400, body: 'Unexpected state.' };
  }

  const error = url.searchParams.get('error');
  if (error !== null && error.length > 0) {
    return { kind: 'denied', reason: error.slice(0, 100) };
  }

  const code = url.searchParams.get('code');
  if (code === null || code.length === 0) {
    return { kind: 'rejected', status: 400, body: 'Missing code.' };
  }
  return { kind: 'accepted', code };
}

function respond(response: http.ServerResponse, status: number, message: string): void {
  const body = `<!doctype html><meta charset="utf-8"><title>artel</title><p>${message}</p>\n`;
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(body)),
  });
  response.end(body);
}
