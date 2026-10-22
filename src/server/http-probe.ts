import http from 'node:http';
import tls from 'node:tls';

/** 응답의 status code. 연결이 안 되거나 `timeoutMs` 안에 header 가 오지 않으면 `null`. */
export function probeStatus(url: string, timeoutMs = 2_000): Promise<number | null> {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      response.resume();
      resolve(response.statusCode ?? null);
    });
    request.on('timeout', () => {
      request.destroy();
    });
    request.on('error', () => {
      resolve(null);
    });
  });
}

/** JSON 본문까지 읽는다. supervisor 의 control 경로처럼 작은 응답에만 쓴다. */
export function probeJson(url: string, timeoutMs = 2_000): Promise<unknown> {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        if (response.statusCode !== 200) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          resolve(null);
        }
      });
      response.on('error', () => resolve(null));
    });
    request.on('timeout', () => {
      request.destroy();
    });
    request.on('error', () => {
      resolve(null);
    });
  });
}

export function postEmpty(
  url: string,
  headers: Record<string, string>,
  timeoutMs = 5_000,
): Promise<number | null> {
  return new Promise((resolve) => {
    const request = http.request(
      url,
      { method: 'POST', headers: { ...headers, 'content-length': '0' }, timeout: timeoutMs },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? null);
      },
    );
    request.on('timeout', () => {
      request.destroy();
    });
    request.on('error', () => {
      resolve(null);
    });
    request.end();
  });
}

/** 연결할 수 있는 host. `0.0.0.0` 처럼 모든 interface 에 묶인 경우는 loopback 으로 연결한다. */
export function connectableHost(host: string): string {
  if (host === '0.0.0.0' || host === '::' || host === '') return '127.0.0.1';
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/**
 * 지문을 아는 supervisor 에게 HTTPS 로 요청한다. supervisor 의 인증서는 자체 서명이거나 `127.0.0.1`
 * 이름이 들어 있지 않을 수 있어 인증서 검증을 켜 둘 수 없다. 대신 handshake 가 끝난 뒤 상대의 인증서
 * 지문이 `state.json` 에 적힌 값과 같을 때만 요청을 쓴다. 다르면 control token 은 나가지 않는다.
 * 응답은 HTTP/1.0 으로 받아 chunked 해석을 피한다.
 */
export function pinnedHttpsRequest(
  target: { host: string; port: number },
  options: {
    method: 'GET' | 'POST';
    path: string;
    headers?: Record<string, string>;
    fingerprint: string;
    timeoutMs?: number;
  },
): Promise<{ status: number; body: string } | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: { status: number; body: string } | null): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    const socket = tls.connect({
      host: target.host.replace(/^\[|\]$/g, ''),
      port: target.port,
      rejectUnauthorized: false,
    });
    socket.setTimeout(options.timeoutMs ?? 2_000, () => finish(null));
    socket.once('error', () => finish(null));
    socket.once('secureConnect', () => {
      if (socket.getPeerCertificate().fingerprint256 !== options.fingerprint) {
        finish(null);
        return;
      }
      const headers: Record<string, string> = {
        host: `${target.host}:${String(target.port)}`,
        ...options.headers,
      };
      if (options.method === 'POST') headers['content-length'] = '0';
      const lines = [`${options.method} ${options.path} HTTP/1.0`];
      for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.once('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const split = text.indexOf('\r\n\r\n');
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(text)?.[1];
      if (split < 0 || status === undefined) {
        finish(null);
        return;
      }
      finish({ status: Number(status), body: text.slice(split + 4) });
    });
  });
}
