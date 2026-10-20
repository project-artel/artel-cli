import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readStackConfig } from '../src/server/config-file.js';
import { startProxy, type RunningProxy } from '../src/server/proxy.js';
import { isPidAlive, readState, writeState } from '../src/server/state-file.js';
import {
  stackStatus,
  startStackWithInternals,
  stopStackWithInternals,
  type OwnedStack,
  type SupervisorEvent,
  type SupervisorInternals,
} from '../src/server/supervisor.js';
import { createFakeRuntime, waitFor, type FakeRuntime } from './server-helpers.js';

const posixOnly = process.platform === 'win32' ? describe.skip : describe;

const internals: SupervisorInternals = {
  timeouts: {
    postgresReadyMs: 10_000,
    orchestrationReadyMs: 10_000,
    agentServerReadyMs: 10_000,
    attachMs: 5_000,
    stopGraceMs: 3_000,
  },
  restartPolicy: { baseDelayMs: 20, maxRestarts: 5, windowMs: 600_000 },
};

posixOnly('supervisor with fake services', () => {
  let runtime: FakeRuntime;
  let events: SupervisorEvent[];
  let stacks: OwnedStack[];

  beforeEach(async () => {
    runtime = await createFakeRuntime();
    events = [];
    stacks = [];
  });

  afterEach(async () => {
    for (const stack of stacks) await stack.stop();
    await runtime.cleanup();
  });

  async function start(port?: number): Promise<OwnedStack> {
    const stack = await startStackWithInternals(
      {
        runtimeDir: runtime.runtimeDir,
        dataDir: runtime.dataDir,
        ...(port === undefined ? {} : { port }),
        onEvent: (event) => events.push(event),
      },
      internals,
    );
    stacks.push(stack);
    return stack;
  }

  it('starts postgres, orchestration, agent-server and the proxy in that order', async () => {
    const stack = await start();

    expect(stack.attached).toBe(false);
    const records = await runtime.records();
    const order = records.map((line) => line.split(' ')[0]);
    expect(order.slice(0, 5)).toEqual([
      'initdb',
      'pg_ctl',
      'createdb',
      'orchestration',
      'agent-server',
    ]);
    expect(records[0]).toContain('-U artel --auth=scram-sha-256 -E UTF8 --locale=C -D');
    expect(records[0]).toContain('pwfile-mode=600');
    expect(records[2]).toContain('artel');
    expect(records[2]).toContain('password=set');
    expect(records[3]).toContain('-Xmx512m -XX:+UseSerialGC -jar');
    expect(records[4]).toContain('-m uvicorn app.main:app --host 127.0.0.1 --port');
    expect(records[4]).toContain('cwd=agent-server store=memory');

    const readyOrder = events
      .filter((event) => event.type === 'service' && event.state === 'ready')
      .map((event) => (event.type === 'service' ? event.service : ''));
    expect(readyOrder).toEqual(['postgres', 'orchestration', 'agent-server', 'proxy']);
    expect(events.at(-1)).toEqual({ type: 'ready', url: stack.url });
    expect(events.some((event) => event.type === 'log' && event.service === 'orchestration')).toBe(
      true,
    );
  });

  it('passes the contract environment to orchestration and agent-server', async () => {
    const stack = await start();
    const config = await readStackConfig(path.join(runtime.dataDir, 'config.json'));
    if (config === null) throw new Error('config.json was not written');
    const env = JSON.parse(
      await fs.readFile(path.join(runtime.root, 'orchestration-env.json'), 'utf8'),
    ) as Record<string, string>;

    expect(env).toMatchObject({
      ARTEL_STORE: 'postgres',
      ARTEL_STORAGE: 'filesystem',
      ARTEL_STORAGE_DIR: path.join(runtime.dataDir, 'storage'),
      SERVER_PORT: String(config.ports.orchestration),
      ARTEL_INTERNAL_API_PORT: String(config.ports.orchestrationInternal),
      DB_HOST: '127.0.0.1',
      DB_PORT: String(config.ports.postgres),
      DB_NAME: 'artel',
      DB_USERNAME: 'artel',
      DB_PASSWORD: config.dbPassword,
      DB_SSL_MODE: 'disable',
      ARTEL_AGENT_BASE_URL: `http://127.0.0.1:${String(config.ports.agentServer)}/internal`,
      ARTEL_AGENT_WS_BASE_URL: `ws://127.0.0.1:${String(config.ports.agentServer)}/internal`,
      ARTEL_HOME_URL: stack.url,
      ARTEL_ALLOWED_ORIGINS: stack.url,
      ARTEL_JWT_SECRET: config.jwtSecret,
      ARTEL_SECRETS_KEY: config.secretsKey,
      ARTEL_SECURE_COOKIE: 'false',
      ARTEL_SIGNUP_OPEN: 'false',
      ARTEL_GITHUB_SIGNUP_OPEN: 'false',
      LOGGING_LEVEL_ORG_SPRINGFRAMEWORK_WEB: 'INFO',
      LOGGING_LEVEL_ORG_SPRINGFRAMEWORK_WEB_REACTIVE: 'INFO',
    });
    const records = await runtime.records();
    expect(records.find((line) => line.startsWith('agent-server'))).toContain(
      `orchestration=http://127.0.0.1:${String(config.ports.orchestrationInternal)}`,
    );
  });

  it('serves home with the URL in place of the placeholder and proxies /api', async () => {
    const stack = await start();
    const html = await (await fetch(`${stack.url}/some/console/route`)).text();
    expect(html).toContain(`window.API="${stack.url}"`);
    const api = (await (await fetch(`${stack.url}/api/projects`)).json()) as { url: string };
    expect(api.url).toBe('/api/projects');
  });

  it('records the supervisor and child pids in state.json and removes it on stop', async () => {
    const stack = await start();
    const stateFile = path.join(runtime.dataDir, 'state.json');
    const state = await readState(stateFile);
    expect(state?.supervisorPid).toBe(process.pid);
    expect(state?.url).toBe(stack.url);
    expect(state?.services).toEqual({
      postgres: 'ready',
      orchestration: 'ready',
      'agent-server': 'ready',
      proxy: 'ready',
    });
    const pids = state?.pids;
    expect(isPidAlive(pids?.orchestration)).toBe(true);
    expect(isPidAlive(pids?.postgres)).toBe(true);

    await stack.stop();
    expect(await readState(stateFile)).toBeNull();
    expect(isPidAlive(pids?.orchestration)).toBe(false);
    expect(isPidAlive(pids?.['agent-server'])).toBe(false);
    expect(isPidAlive(pids?.postgres)).toBe(false);
    const records = await runtime.records();
    const stopOrder = records.filter((line) => /SIGTERM|pg_ctl stop/.test(line));
    expect(stopOrder.map((line) => line.split(' ')[0])).toEqual([
      'agent-server',
      'orchestration',
      'pg_ctl',
    ]);
    expect(stopOrder[2]).toContain('-m fast');
    expect((await stackStatus({ dataDir: runtime.dataDir })).running).toBe(false);
  });

  it('reuses pgdata and secrets on the next start', async () => {
    const first = await start();
    const before = await readStackConfig(path.join(runtime.dataDir, 'config.json'));
    await first.stop();
    await start();
    const after = await readStackConfig(path.join(runtime.dataDir, 'config.json'));

    const records = await runtime.records();
    expect(records.filter((line) => line.startsWith('initdb'))).toHaveLength(1);
    expect(records.filter((line) => line.startsWith('createdb'))).toHaveLength(1);
    expect(after?.jwtSecret).toBe(before?.jwtSecret);
    expect(after?.dbPassword).toBe(before?.dbPassword);
  });

  it('attaches instead of starting a second stack in the same process', async () => {
    const first = await start();
    const second = await start();
    expect(second).toMatchObject({ attached: true, url: first.url });
    expect((await runtime.records()).filter((line) => line.startsWith('initdb'))).toHaveLength(1);
  });

  it('stopStack stops a stack this process owns', async () => {
    await start();
    await stopStackWithInternals({ dataDir: runtime.dataDir }, internals);
    expect(await readState(path.join(runtime.dataDir, 'state.json'))).toBeNull();
  });

  it('fails with the log file named when orchestration exits during start, and stops postgres', async () => {
    await fs.writeFile(path.join(runtime.root, 'orchestration-fails'), '');
    await expect(start()).rejects.toThrow(
      new RegExp(
        `orchestration exited with code 3 before it became ready\\. See .*orchestration\\.log`,
      ),
    );
    const records = await runtime.records();
    expect(records.at(-1)).toMatch(/^pg_ctl stop/);
    expect(await readState(path.join(runtime.dataDir, 'state.json'))).toBeNull();
    const log = await fs.readFile(path.join(runtime.dataDir, 'logs', 'orchestration.log'), 'utf8');
    expect(log).toContain('orchestration refuses to start');
  });

  it('restarts a crashed orchestration with backoff', async () => {
    const stack = await start();
    const before = (await readState(path.join(runtime.dataDir, 'state.json')))?.pids.orchestration;
    await fetch(`${stack.url}/api/crash`);

    await waitFor(async () => {
      const state = await readState(path.join(runtime.dataDir, 'state.json'));
      return (
        state?.services.orchestration === 'ready' &&
        state.pids.orchestration !== before &&
        state.pids.orchestration !== null
      );
    });
    const restarting = events.find(
      (event) =>
        event.type === 'service' &&
        event.service === 'orchestration' &&
        event.state === 'starting' &&
        (event.detail ?? '').includes('restarting in 20 ms'),
    );
    expect(restarting).toBeDefined();
  });

  it('marks orchestration crashed after 5 restarts in the window', async () => {
    const stack = await start();
    await fs.writeFile(path.join(runtime.root, 'orchestration-fails'), '');
    await fetch(`${stack.url}/api/crash`);

    await waitFor(
      () =>
        events.some(
          (event) =>
            event.type === 'service' &&
            event.service === 'orchestration' &&
            event.state === 'crashed',
        ),
      20_000,
    );
    const refused = (await runtime.records()).filter((line) => line === 'orchestration refused');
    expect(refused).toHaveLength(5);
    const status = await stackStatus({ dataDir: runtime.dataDir });
    expect(status.services.orchestration).toBe('crashed');
    expect(status.services.postgres).toBe('ready');
  }, 30_000);
});

posixOnly('supervisor lock', () => {
  let runtime: FakeRuntime;
  let holder: ChildProcess | null = null;
  let proxy: RunningProxy | null = null;

  beforeEach(async () => {
    runtime = await createFakeRuntime();
  });

  afterEach(async () => {
    holder?.kill();
    holder = null;
    await proxy?.close();
    proxy = null;
    await runtime.cleanup();
  });

  function baseState(pid: number, port: number) {
    return {
      schemaVersion: 1 as const,
      supervisorPid: pid,
      url: `http://127.0.0.1:${String(port)}`,
      host: '127.0.0.1',
      proxyPort: port,
      runtimeDir: runtime.runtimeDir,
      runtimeVersion: '0.1.0',
      startedAt: new Date().toISOString(),
      controlToken: 'token',
      pids: { postgres: null, orchestration: null, 'agent-server': null, proxy: pid },
      services: {
        postgres: 'ready' as const,
        orchestration: 'ready' as const,
        'agent-server': 'ready' as const,
        proxy: 'ready' as const,
      },
    };
  }

  it('attaches to a live supervisor in another process whose proxy answers', async () => {
    holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    const pid = holder.pid ?? 0;
    proxy = await startProxy({
      host: '127.0.0.1',
      port: 0,
      orchestrationPort: 1,
      homeDir: runtime.root,
      control: { pid, token: 'token', runtimeVersion: '0.1.0', onStopRequested: () => undefined },
    });
    await fs.mkdir(runtime.dataDir, { recursive: true });
    await writeState(path.join(runtime.dataDir, 'state.json'), baseState(pid, proxy.port));

    const stack = await startStackWithInternals(
      { runtimeDir: runtime.runtimeDir, dataDir: runtime.dataDir },
      internals,
    );

    expect(stack).toMatchObject({ attached: true, url: `http://127.0.0.1:${String(proxy.port)}` });
    expect(await runtime.records()).toEqual([]);
    await stack.stop();
    expect(isPidAlive(pid)).toBe(true);
  });

  it('cleans a stale state.json whose supervisor is gone and starts', async () => {
    await fs.mkdir(runtime.dataDir, { recursive: true });
    const dead = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    await new Promise((resolve) => dead.once('exit', resolve));
    await writeState(path.join(runtime.dataDir, 'state.json'), baseState(dead.pid ?? 0, 1));
    await fs.writeFile(path.join(runtime.dataDir, 'supervisor.lock'), String(dead.pid ?? 0));

    const stack = await startStackWithInternals(
      { runtimeDir: runtime.runtimeDir, dataDir: runtime.dataDir },
      internals,
    );
    try {
      expect(stack.attached).toBe(false);
      expect((await readState(path.join(runtime.dataDir, 'state.json')))?.supervisorPid).toBe(
        process.pid,
      );
    } finally {
      await stack.stop();
    }
  });
});
