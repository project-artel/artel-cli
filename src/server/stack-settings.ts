import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import tls from 'node:tls';

import {
  DEFAULT_PROXY_PORT,
  generateSecrets,
  readStackConfig,
  resolvePorts,
  withNetwork,
  writePrivateJson,
  type StackConfig,
  type StackTls,
} from './config-file.js';
import { SupervisorError } from './errors.js';
import { connectableHost } from './http-probe.js';
import { dataPaths, defaultDataDir } from './paths.js';

export type { StackTls } from './config-file.js';

export const DEFAULT_HOST = '127.0.0.1';

/** desktop app 과 CLI 가 읽고 쓰는 stack 의 네트워크 설정. `config.json` 에 저장된다. */
export interface StackSettings {
  /** proxy 가 listen 할 host. `0.0.0.0` 이면 다른 기계에서도 접속할 수 있다. */
  host: string;
  /** proxy port. */
  port: number;
  /** 사람이 여는 주소. 기본값은 `${tls ? 'https' : 'http'}://127.0.0.1:${port}`. */
  publicUrl: string;
  tls: StackTls | null;
}

/** start 의 옵션처럼 일부만 정해진 설정. `tls: null` 은 TLS 를 끈다는 명시다. */
export interface ExplicitSettings {
  host?: string | undefined;
  port?: number | undefined;
  publicUrl?: string | undefined;
  tls?: StackTls | null | undefined;
}

/** start 마다 다시 읽는 인증서 파일의 내용. */
export interface TlsMaterial {
  cert: Buffer;
  key: Buffer;
  /** 인증서 첫 장의 SHA-256 지문. 다른 process 가 loopback 으로 접속할 때 이 값으로 상대를 확인한다. */
  fingerprint: string;
}

function invalid(message: string): SupervisorError {
  return new SupervisorError('server_settings_invalid', message);
}

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, '');
}

export function defaultPublicUrl(host: string, port: number, secure: boolean): string {
  return `${secure ? 'https' : 'http'}://${connectableHost(host)}:${String(port)}`;
}

export function isLoopbackHost(host: string): boolean {
  const lower = host.trim().toLowerCase();
  return (
    lower === 'localhost' ||
    lower === '::1' ||
    lower === '[::1]' ||
    /^127(\.\d{1,3}){3}$/.test(lower)
  );
}

function resolveTls(value: StackTls): StackTls {
  return { certFile: path.resolve(value.certFile), keyFile: path.resolve(value.keyFile) };
}

/** 저장된 값 위에 명시한 값을 얹는다. 순서는 명시한 값, `config.json`, 기본값이다. */
export function effectiveSettings(
  saved: StackConfig | null,
  explicit: ExplicitSettings = {},
): StackSettings {
  const host = explicit.host?.trim() || saved?.host || DEFAULT_HOST;
  const port = explicit.port ?? saved?.ports.proxy ?? DEFAULT_PROXY_PORT;
  const tlsValue = explicit.tls === undefined ? (saved?.tls ?? null) : explicit.tls;
  const resolvedTls = tlsValue === null ? null : resolveTls(tlsValue);
  const publicUrl = stripTrailingSlashes(
    explicit.publicUrl?.trim() ||
      saved?.publicUrl ||
      defaultPublicUrl(host, port, resolvedTls !== null),
  );
  return { host, port, publicUrl, tls: resolvedTls };
}

/** TLS 파일을 읽고 key pair 가 맞는지 본다. TLS 가 없으면 `null`. */
export async function loadTlsMaterial(value: StackTls | null): Promise<TlsMaterial | null> {
  if (value === null) return null;
  const read = async (file: string, label: string): Promise<Buffer> => {
    try {
      return await fs.readFile(file);
    } catch (error) {
      throw invalid(`The TLS ${label} file ${file} cannot be read: ${(error as Error).message}`);
    }
  };
  const cert = await read(value.certFile, 'certificate');
  const key = await read(value.keyFile, 'private key');
  try {
    tls.createSecureContext({ cert, key });
  } catch (error) {
    throw invalid(
      `The TLS certificate ${value.certFile} and key ${value.keyFile} are not a valid pair: ${(error as Error).message}`,
    );
  }
  let fingerprint: string;
  try {
    fingerprint = new crypto.X509Certificate(cert).fingerprint256;
  } catch (error) {
    throw invalid(
      `The TLS certificate ${value.certFile} cannot be parsed: ${(error as Error).message}`,
    );
  }
  return { cert, key, fingerprint };
}

/** 설정이 start 할 수 있는 값인지 확인한다. TLS 파일을 읽어 돌려준다. */
export async function validateSettings(settings: StackSettings): Promise<TlsMaterial | null> {
  if (settings.host.length === 0 || /\s/.test(settings.host)) {
    throw invalid(`host "${settings.host}" is not a valid address.`);
  }
  if (!Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65_535) {
    throw invalid(`port ${String(settings.port)} must be an integer from 1 to 65535.`);
  }
  let url: URL;
  try {
    url = new URL(settings.publicUrl);
  } catch {
    throw invalid(`publicUrl "${settings.publicUrl}" is not an absolute URL.`);
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname.length === 0) {
    throw invalid(`publicUrl "${settings.publicUrl}" must be an absolute http or https URL.`);
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '') {
    throw invalid(
      `publicUrl "${settings.publicUrl}" must be an origin only: no path, query, fragment or credentials.`,
    );
  }
  const material = await loadTlsMaterial(settings.tls);
  if (settings.tls !== null && url.protocol === 'http:') {
    throw invalid(
      `TLS is set, so publicUrl must be https, but it is ${settings.publicUrl}. Set publicUrl to an https address, or remove the TLS files.`,
    );
  }
  return material;
}

/** 모든 기계에 열려 있는데 암호화가 없을 때의 경고. 해당하지 않으면 `null`. */
export function plainTextWarning(
  settings: Pick<StackSettings, 'host' | 'publicUrl'>,
): string | null {
  if (isLoopbackHost(settings.host) || !settings.publicUrl.startsWith('http://')) return null;
  return `The proxy listens on ${settings.host} over plain http, so passwords and session cookies cross the network unencrypted. Set --tls-cert and --tls-key, or put an https front such as a tunnel in front and set --public-url to its address.`;
}

function resolveDataDir(dataDir: string | undefined): string {
  return path.resolve(dataDir?.trim() || defaultDataDir(process.env));
}

/** stack 이 한 번도 뜨지 않았어도 읽을 수 있다. 저장된 값이 없으면 기본값이다. */
export async function readStackSettings(
  options: { dataDir?: string } = {},
): Promise<StackSettings> {
  const paths = dataPaths(resolveDataDir(options.dataDir));
  return effectiveSettings(await readStackConfig(paths.configFile));
}

/**
 * 설정을 검증해 `config.json` 에 쓰고 합친 값을 돌려준다. 이미 떠 있는 stack 에는 영향이 없고
 * 다음 start 부터 적용된다.
 */
export async function writeStackSettings(
  changes: Partial<StackSettings>,
  options: { dataDir?: string } = {},
): Promise<StackSettings> {
  const paths = dataPaths(resolveDataDir(options.dataDir));
  const saved = await readStackConfig(paths.configFile);
  const settings = effectiveSettings(saved, changes);
  await validateSettings(settings);

  const other =
    saved === null ? [] : Object.entries(saved.ports).filter(([name]) => name !== 'proxy');
  const clash = other.find(([, port]) => port === settings.port);
  if (clash !== undefined) {
    throw invalid(
      `port ${String(settings.port)} is already used by the ${clash[0]} service of this stack.`,
    );
  }

  // publicUrl 은 사용자가 정했을 때만 남긴다. 그래야 port 나 TLS 를 바꾸면 기본값이 따라 바뀐다.
  const keepPublicUrl = changes.publicUrl !== undefined ? settings.publicUrl : saved?.publicUrl;
  const network: Pick<StackConfig, 'host' | 'publicUrl' | 'tls'> = {
    host: settings.host,
    ...(keepPublicUrl === undefined ? {} : { publicUrl: keepPublicUrl }),
    ...(settings.tls === null ? {} : { tls: settings.tls }),
  };

  let config: StackConfig;
  if (saved === null) {
    const pgdataExists = await fs
      .access(path.join(paths.pgdata, 'PG_VERSION'))
      .then(() => true)
      .catch(() => false);
    if (pgdataExists) {
      throw invalid(
        `${paths.configFile} is missing or unreadable, but ${paths.pgdata} already holds a database. Writing new settings would create new secrets that do not match it. Restore the file first.`,
      );
    }
    const ports = await resolvePorts(null, { host: settings.host });
    config = withNetwork(
      { schemaVersion: 1, ...generateSecrets(), ports: { ...ports, proxy: settings.port } },
      network,
    );
  } else {
    config = withNetwork({ ...saved, ports: { ...saved.ports, proxy: settings.port } }, network);
  }
  await writePrivateJson(paths.configFile, config);
  return settings;
}
