import net from 'node:net';

/** `host:port` 에 지금 listen 할 수 있는가. 확인한 뒤 바로 닫는다. */
export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => {
      resolve(false);
    });
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => {
        resolve(true);
      });
    });
  });
}

/** OS 가 고른 빈 port. `exclude` 에 든 번호가 나오면 다시 받는다. */
export async function findFreePort(
  host = '127.0.0.1',
  exclude: ReadonlySet<number> = new Set(),
): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.once('error', reject);
      server.listen({ port: 0, host }, () => {
        const address = server.address();
        const chosen = typeof address === 'object' && address !== null ? address.port : 0;
        server.close(() => {
          resolve(chosen);
        });
      });
    });
    if (port > 0 && !exclude.has(port)) return port;
  }
  throw new Error(`Could not find a free port on ${host}.`);
}

/**
 * `preferred` 가 비어 있으면 그것을, 아니면 빈 port 를 고른다. `preferred` 가 `undefined` 면
 * 바로 빈 port 를 고른다.
 */
export async function choosePort(
  preferred: number | undefined,
  host: string,
  exclude: ReadonlySet<number>,
): Promise<number> {
  if (preferred !== undefined && !exclude.has(preferred) && (await isPortFree(preferred, host))) {
    return preferred;
  }
  return findFreePort(host, exclude);
}
