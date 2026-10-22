import fs from 'node:fs';
import fsp from 'node:fs/promises';

import { writePrivateJson } from './config-file.js';

export const SERVICE_NAMES = ['postgres', 'orchestration', 'agent-server', 'proxy'] as const;

export type ServiceName = (typeof SERVICE_NAMES)[number];
export type ServiceState = 'stopped' | 'starting' | 'ready' | 'crashed';

/**
 * `state.json`. 살아 있는 supervisor 하나가 쓰고, CLI 와 desktop app 이 읽어 같은 stack 에
 * 붙는다. `controlToken` 은 다른 process 가 이 supervisor 에게 종료를 요청할 때 쓰는 값이라
 * 파일을 0600 으로 쓴다.
 */
export interface StackState {
  schemaVersion: 1;
  supervisorPid: number;
  url: string;
  host: string;
  proxyPort: number;
  runtimeDir: string;
  runtimeVersion: string;
  startedAt: string;
  controlToken: string;
  /**
   * proxy 가 직접 HTTPS 를 끝낼 때 인증서의 SHA-256 지문. 있으면 control 요청은 HTTPS 로 가고, 이
   * 지문과 같은 인증서를 낸 상대에게만 token 을 보낸다.
   */
  tlsFingerprint?: string | null;
  /** 각 service 의 pid. postgres 는 postmaster 의 pid 이고 proxy 는 supervisor 자신이다. */
  pids: Record<ServiceName, number | null>;
  services: Record<ServiceName, ServiceState>;
}

export function emptyServiceStates(): Record<ServiceName, ServiceState> {
  return {
    postgres: 'stopped',
    orchestration: 'stopped',
    'agent-server': 'stopped',
    proxy: 'stopped',
  };
}

function parseState(text: string): StackState | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Partial<StackState>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.supervisorPid !== 'number' ||
    typeof record.url !== 'string' ||
    typeof record.controlToken !== 'string' ||
    typeof record.pids !== 'object' ||
    record.pids === null ||
    typeof record.services !== 'object' ||
    record.services === null
  ) {
    return null;
  }
  return record as StackState;
}

export async function readState(stateFile: string): Promise<StackState | null> {
  try {
    return parseState(await fsp.readFile(stateFile, 'utf8'));
  } catch {
    return null;
  }
}

/** `config.ts` 가 동기 함수라서 둔 동기 판. */
export function readStateSync(stateFile: string): StackState | null {
  try {
    return parseState(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return null;
  }
}

export async function writeState(stateFile: string, state: StackState): Promise<void> {
  await writePrivateJson(stateFile, state);
}

export async function removeState(stateFile: string): Promise<void> {
  await fsp.rm(stateFile, { force: true });
}

/**
 * signal 0 은 보내지 않고 존재만 확인한다. `EPERM` 은 다른 사용자의 process 가 그 pid 를 쓰고
 * 있다는 뜻이라 살아 있다고 본다.
 */
export function isPidAlive(pid: number | null | undefined): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
