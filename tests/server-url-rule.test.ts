import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_API_BASE_URL,
  effectiveApiBaseUrl,
  resolveApiBaseUrl,
  resolveConfig,
} from '../src/config.js';
import { localStackUrl } from '../src/server/local-stack.js';
import { writeState } from '../src/server/state-file.js';

/** 공유 계약 4절. desktop app 이 함께 설치한 CLI 는 떠 있는 local stack 을 기본 주소로 쓴다. */
const LOCAL = 'http://127.0.0.1:8088';

describe('local stack URL rule', () => {
  let xdg: string;

  beforeEach(async () => {
    xdg = await fs.mkdtemp(path.join(os.tmpdir(), 'artel-url-rule-'));
  });

  afterEach(async () => {
    await fs.rm(xdg, { recursive: true, force: true });
  });

  async function writeLocalState(pid: number): Promise<void> {
    await writeState(path.join(xdg, 'artel', 'state.json'), {
      schemaVersion: 1,
      supervisorPid: pid,
      url: `${LOCAL}/`,
      host: '127.0.0.1',
      proxyPort: 8088,
      runtimeDir: '/runtime',
      runtimeVersion: '0.1.0',
      startedAt: new Date().toISOString(),
      controlToken: 'token',
      pids: { postgres: null, orchestration: null, 'agent-server': null, proxy: pid },
      services: {
        postgres: 'ready',
        orchestration: 'ready',
        'agent-server': 'ready',
        proxy: 'ready',
      },
    });
  }

  const runtimeEnv = (): NodeJS.ProcessEnv => ({
    ARTEL_RUNTIME_DIR: '/runtime',
    XDG_DATA_HOME: xdg,
  });

  it.skipIf(process.platform !== 'linux')(
    'reads the running stack from the data directory',
    async () => {
      await writeLocalState(process.pid);
      expect(localStackUrl(runtimeEnv())).toBe(LOCAL);
      expect(effectiveApiBaseUrl(runtimeEnv(), null)).toEqual({
        value: LOCAL,
        source: 'local-stack',
      });
    },
  );

  it.skipIf(process.platform !== 'linux')(
    'ignores a state.json whose supervisor is gone',
    async () => {
      const dead = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
      await new Promise((resolve) => dead.once('exit', resolve));
      await writeLocalState(dead.pid ?? 0);
      expect(localStackUrl(runtimeEnv())).toBeNull();
      expect(effectiveApiBaseUrl(runtimeEnv(), null).source).toBe('default');
    },
  );

  it.skipIf(process.platform !== 'linux')('needs ARTEL_RUNTIME_DIR', async () => {
    await writeLocalState(process.pid);
    expect(localStackUrl({ XDG_DATA_HOME: xdg })).toBeNull();
  });

  it('lets a flag, ARTEL_API_BASE_URL and the credentials file win over the local stack', () => {
    const lookup = () => LOCAL;
    expect(resolveApiBaseUrl({}, 'https://flag.example.test', null, lookup)).toBe(
      'https://flag.example.test',
    );
    expect(
      effectiveApiBaseUrl({ ARTEL_API_BASE_URL: 'https://env.example.test' }, null, lookup).source,
    ).toBe('env');
    expect(effectiveApiBaseUrl({}, 'https://file.example.test', lookup).source).toBe('file');
    expect(effectiveApiBaseUrl({}, null, lookup)).toEqual({ value: LOCAL, source: 'local-stack' });
    expect(effectiveApiBaseUrl({}, null, () => null)).toEqual({
      value: DEFAULT_API_BASE_URL,
      source: 'default',
    });
  });

  it('uses the local stack as the console too', () => {
    const lookup = () => LOCAL;
    expect(resolveConfig({}, {}, null, lookup)).toEqual({
      apiBaseUrl: LOCAL,
      consoleBaseUrl: LOCAL,
    });
    // 로그인 뒤 자격증명 파일에 저장된 주소가 local stack 이어도 console 은 같은 주소다.
    expect(resolveConfig({}, {}, `${LOCAL}/`, lookup).consoleBaseUrl).toBe(LOCAL);
    expect(
      resolveConfig({}, { consoleBaseUrl: 'https://console.example.test' }, null, lookup)
        .consoleBaseUrl,
    ).toBe('https://console.example.test');
  });
});
