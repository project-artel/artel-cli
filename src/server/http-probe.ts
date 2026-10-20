import http from 'node:http';

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
