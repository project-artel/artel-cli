import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { CLI_TOKEN_EXCHANGE_PATH, exchangeCliToken } from '../src/http/client.js';
import type { CliError } from '../src/errors.js';

interface StubServer {
  baseUrl: string;
  received: { method: string; url: string; body: string }[];
  close(): Promise<void>;
}

const openServers: StubServer[] = [];

async function startStub(
  respond: (request: http.IncomingMessage, response: http.ServerResponse, body: string) => void,
): Promise<StubServer> {
  const received: { method: string; url: string; body: string }[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      received.push({ method: request.method ?? '', url: request.url ?? '', body });
      respond(request, response, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the stub server did not bind to a TCP port');
  }
  const stub: StubServer = {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    received,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    },
  };
  openServers.push(stub);
  return stub;
}

const request = {
  code: 'one-time-code',
  codeVerifier: 'x'.repeat(43),
  name: 'artel-cli@test',
  expiresInDays: 90,
};

afterEach(async () => {
  while (openServers.length > 0) {
    await openServers.pop()?.close();
  }
});

describe('CLI token exchange', () => {
  it('posts the code, verifier, name and expiry to the exchange endpoint', async () => {
    const stub = await startStub((_request, response) => {
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: '01JX',
          name: 'artel-cli@test',
          token: 'artel_issued',
          createdAt: '2026-09-03T04:11:07Z',
          expiresAt: null,
        }),
      );
    });

    const issued = await exchangeCliToken(stub.baseUrl, request);

    expect(issued).toEqual({
      id: '01JX',
      name: 'artel-cli@test',
      token: 'artel_issued',
      createdAt: '2026-09-03T04:11:07Z',
      expiresAt: null,
    });
    expect(stub.received[0]?.method).toBe('POST');
    expect(stub.received[0]?.url).toBe(CLI_TOKEN_EXCHANGE_PATH);
    expect(JSON.parse(stub.received[0]?.body ?? '{}')).toEqual(request);
  });

  /**
   * 이 endpoint 는 아직 서버에 없다. 404 를 일반적인 `server_error` 로 뭉개면 사용자는
   * 자기 설정이 잘못된 줄 안다.
   */
  it('names the missing endpoint when the server answers 404', async () => {
    const stub = await startStub((_request, response) => {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"code":"not_found","message":"No handler"}');
    });

    const failure = (await exchangeCliToken(stub.baseUrl, request).catch(
      (error: unknown) => error,
    )) as CliError;

    expect(failure.code).toBe('login_not_supported');
    expect(failure.message).toContain('has no');
    expect(failure.message).toContain('older than it');
    expect(failure.message).toContain(CLI_TOKEN_EXCHANGE_PATH);
    expect(failure.message).toContain('ARTEL_TOKEN');
  });

  it('carries the status and the server code into a server_error', async () => {
    const stub = await startStub((_request, response) => {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end('{"code":"invalid_grant","message":"code already used"}');
    });

    const failure = (await exchangeCliToken(stub.baseUrl, request).catch(
      (error: unknown) => error,
    )) as CliError;

    expect(failure.code).toBe('server_error');
    expect(failure.message).toContain('HTTP 400');
    expect(failure.message).toContain('invalid_grant');
    expect(failure.message).toContain('code already used');
  });

  it('refuses a success body that has no token', async () => {
    const stub = await startStub((_request, response) => {
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end('{"id":"01JX","name":"n","createdAt":"2026-09-03T04:11:07Z"}');
    });

    const failure = (await exchangeCliToken(stub.baseUrl, request).catch(
      (error: unknown) => error,
    )) as CliError;

    expect(failure.code).toBe('server_error');
    expect(failure.message).toContain('"token"');
  });

  it('reports an unreachable server as network_error', async () => {
    const stub = await startStub((_request, response) => response.end());
    const deadBaseUrl = stub.baseUrl;
    await stub.close();

    const failure = (await exchangeCliToken(deadBaseUrl, request).catch(
      (error: unknown) => error,
    )) as CliError;

    expect(failure.code).toBe('network_error');
  });
});
