import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { SupervisorError } from './errors.js';
import { choosePort, isPortFree } from './ports.js';

/** 첫 start 가 proxy 에 먼저 시도하는 port. 쓰이고 있으면 빈 port 로 넘어간다. */
export const DEFAULT_PROXY_PORT = 8088;

export interface StackPorts {
  proxy: number;
  postgres: number;
  orchestration: number;
  orchestrationInternal: number;
  agentServer: number;
}

/** `config.json`. secret 이 들어 있어 mode 0600 으로만 쓴다. */
export interface StackConfig {
  schemaVersion: 1;
  jwtSecret: string;
  secretsKey: string;
  dbPassword: string;
  ports: StackPorts;
}

const PORT_KEYS: readonly (keyof StackPorts)[] = [
  'proxy',
  'postgres',
  'orchestration',
  'orchestrationInternal',
  'agentServer',
];

export function generateSecrets(
  randomBytes: (size: number) => Buffer = crypto.randomBytes,
): Pick<StackConfig, 'jwtSecret' | 'secretsKey' | 'dbPassword'> {
  return {
    jwtSecret: randomBytes(48).toString('base64'),
    secretsKey: randomBytes(48).toString('base64'),
    // DB 비밀번호는 `--pwfile` 과 연결 문자열에 그대로 실리므로 따옴표나 공백이 없는 hex 로 만든다.
    dbPassword: randomBytes(24).toString('hex'),
  };
}

function parsePorts(value: unknown): StackPorts | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const ports = {} as StackPorts;
  for (const key of PORT_KEYS) {
    const port = record[key];
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) {
      return null;
    }
    ports[key] = port;
  }
  return ports;
}

/** 읽지 못하거나 모양이 다르면 `null`. 부르는 쪽이 새로 만들지 거절할지 정한다. */
export async function readStackConfig(configFile: string): Promise<StackConfig | null> {
  let text: string;
  try {
    text = await fs.readFile(configFile, 'utf8');
  } catch {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const ports = parsePorts(record.ports);
  if (
    record.schemaVersion !== 1 ||
    typeof record.jwtSecret !== 'string' ||
    typeof record.secretsKey !== 'string' ||
    typeof record.dbPassword !== 'string' ||
    ports === null
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    jwtSecret: record.jwtSecret,
    secretsKey: record.secretsKey,
    dbPassword: record.dbPassword,
    ports,
  };
}

/**
 * 0600 으로 연 임시 파일에 쓰고 rename 한다. 이미 있는 파일에 `mode` 를 주어도 권한은 바뀌지 않고,
 * 쓰고 나서 chmod 하면 그 사이에 다른 사용자가 읽을 수 있다.
 */
export async function writePrivateJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${String(process.pid)}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'w' });
  await fs.rename(temporary, file);
}

export interface PortRequest {
  /** 사용자가 `--port` 로 고른 proxy port. 비어 있지 않으면 실패한다. */
  proxyPort?: number | undefined;
  /** proxy 가 listen 할 host. 다른 service 는 언제나 `127.0.0.1` 이다. */
  host: string;
}

/**
 * 저장된 port 가 비어 있으면 그대로 쓰고, 다른 프로그램이 잡고 있으면 새로 고른다. 사용자가
 * `--port` 로 고른 proxy port 만은 바꾸지 않고 거절한다: 다른 port 로 몰래 바꾸면 사용자가 연
 * 주소가 틀린다.
 */
export async function resolvePorts(
  saved: StackPorts | null,
  request: PortRequest,
): Promise<StackPorts> {
  const taken = new Set<number>();
  let proxy: number;
  if (request.proxyPort !== undefined) {
    if (!(await isPortFree(request.proxyPort, request.host))) {
      throw new SupervisorError(
        'server_port_in_use',
        `Port ${String(request.proxyPort)} on ${request.host} is already in use. Choose another with --port.`,
      );
    }
    proxy = request.proxyPort;
  } else {
    proxy = await choosePort(saved?.proxy ?? DEFAULT_PROXY_PORT, request.host, taken);
  }
  taken.add(proxy);

  const pick = async (key: Exclude<keyof StackPorts, 'proxy'>): Promise<number> => {
    const port = await choosePort(saved?.[key], '127.0.0.1', taken);
    taken.add(port);
    return port;
  };
  return {
    proxy,
    postgres: await pick('postgres'),
    orchestration: await pick('orchestration'),
    orchestrationInternal: await pick('orchestrationInternal'),
    agentServer: await pick('agentServer'),
  };
}

/** 첫 start 에 secret 을 만들고, 이후에는 저장된 secret 을 그대로 쓰며 port 만 다시 확인한다. */
export async function loadOrCreateStackConfig(
  configFile: string,
  request: PortRequest,
): Promise<StackConfig> {
  const saved = await readStackConfig(configFile);
  const ports = await resolvePorts(saved?.ports ?? null, request);
  const config: StackConfig = saved
    ? { ...saved, ports }
    : { schemaVersion: 1, ...generateSecrets(), ports };
  await writePrivateJson(configFile, config);
  return config;
}
