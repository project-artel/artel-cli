import crypto from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  loadOrCreateStackConfig,
  readStackConfig,
  type StackConfig,
  type StackTls,
} from './config-file.js';
import { SupervisorError } from './errors.js';
import { prepareHome } from './home.js';
import {
  connectableHost,
  pinnedHttpsRequest,
  postEmpty,
  probeJson,
  probeStatus,
} from './http-probe.js';
import {
  followFile,
  logFilePath,
  RotatingLog,
  rotateIfLarge,
  type FileFollower,
  type LogFileName,
} from './logs.js';
import { loadRuntime, type RuntimeLayout } from './manifest.js';
import {
  currentTarget,
  dataPaths,
  defaultDataDir,
  resolveRuntimeDir,
  type DataPaths,
} from './paths.js';
import {
  ensureCluster,
  ensureDatabase,
  isPostgresReady,
  postgresEnv,
  postmasterPid,
  startPostgres,
  stopPostgres,
  writeSettings,
  type PostgresContext,
} from './postgres.js';
import { assertNotPrivileged } from './privilege.js';
import { spawnService, stopProcessTree } from './process.js';
import {
  CONTROL_PATH,
  CONTROL_STOP_PATH,
  CONTROL_TOKEN_HEADER,
  startProxy,
  type RunningProxy,
} from './proxy.js';
import {
  effectiveSettings,
  plainTextWarning,
  validateSettings,
  type StackSettings,
  type TlsMaterial,
} from './stack-settings.js';
import { agentServerCommand, orchestrationCommand, type ServiceCommand } from './services.js';
import {
  emptyServiceStates,
  isPidAlive,
  readState,
  removeState,
  writeState,
  SERVICE_NAMES,
  type ServiceName,
  type ServiceState,
  type StackState,
} from './state-file.js';

export type { ServiceName, ServiceState } from './state-file.js';

export interface SupervisorOptions {
  /** 기본값은 `ARTEL_RUNTIME_DIR`, 그다음 `<dataDir>/runtime/<version>`. */
  runtimeDir?: string;
  /** 기본값은 `defaultDataDir()`. */
  dataDir?: string;
  /**
   * proxy 가 listen 할 host. 명시한 값, `config.json`, 기본값 `127.0.0.1` 의 순서로 정한다.
   * 명시한 값은 `config.json` 에 저장된다. `port`, `publicUrl`, `tls` 도 같다.
   */
  host?: string;
  /** proxy port. 첫 start 는 8088 을 먼저 시도한다. */
  port?: number;
  /** 기본값 `http(s)://127.0.0.1:<port>`. `tls` 가 있으면 https 여야 한다. */
  publicUrl?: string;
  /** 인증서와 key 파일. 주면 proxy 가 HTTPS 로 listen 한다. `null` 은 저장된 TLS 를 끈다. */
  tls?: StackTls | null;
  onEvent?: (event: SupervisorEvent) => void;
}

export type SupervisorEvent =
  | { type: 'service'; service: ServiceName; state: ServiceState; detail?: string }
  | { type: 'log'; service: ServiceName; line: string }
  | { type: 'ready'; url: string }
  /** start 는 계속된다. 사용자가 알아야 할 위험이 있을 때 한 번 낸다. */
  | { type: 'warning'; code: 'plain_text_exposure'; message: string };

export interface RunningStack {
  url: string;
  attached: boolean;
  stop(): Promise<void>;
}

export interface StackStatus {
  running: boolean;
  url?: string;
  pid?: number;
  services: Record<ServiceName, ServiceState>;
}

/** `startStack` 이 실제로 돌려주는 값. `closed` 는 이 process 가 stack 을 다 멈췄을 때 풀린다. */
export interface OwnedStack extends RunningStack {
  closed: Promise<void>;
}

export interface SupervisorTimeouts {
  postgresReadyMs: number;
  orchestrationReadyMs: number;
  agentServerReadyMs: number;
  /** 다른 supervisor 가 띄우는 중인 stack 에 붙기까지 기다리는 시간. */
  attachMs: number;
  /** SIGTERM 뒤 SIGKILL 까지 기다리는 시간. */
  stopGraceMs: number;
}

export interface RestartPolicy {
  maxRestarts: number;
  windowMs: number;
  baseDelayMs: number;
}

/** 테스트와 CLI 만 쓰는 조정값. 공유 계약의 API 에는 없다. */
export interface SupervisorInternals {
  timeouts?: Partial<SupervisorTimeouts>;
  restartPolicy?: Partial<RestartPolicy>;
  env?: NodeJS.ProcessEnv;
  /** root/관리자 검사를 건너뛴다. CI 가 root 로 도는 테스트만 쓴다. */
  skipPrivilegeCheck?: boolean;
  /** 데이터 디렉터리를 쓰기 전에 이 값을 runtime target 과 비교한다. 테스트가 바꾼다. */
  target?: string | null;
}

export const DEFAULT_TIMEOUTS: SupervisorTimeouts = {
  postgresReadyMs: 120_000,
  // 첫 start 의 Flyway migration 과 JVM 기동을 합친 값이다.
  orchestrationReadyMs: 300_000,
  agentServerReadyMs: 120_000,
  attachMs: 600_000,
  stopGraceMs: 20_000,
};

/** crash 한 process 를 10 분 안에 5 번까지 다시 띄운다. 간격은 1, 2, 4, 8, 16 초. */
export const DEFAULT_RESTART_POLICY: RestartPolicy = {
  maxRestarts: 5,
  windowMs: 10 * 60_000,
  baseDelayMs: 1_000,
};

const LOCK_FILE = 'supervisor.lock';
const POSTGRES_WATCH_INTERVAL_MS = 2_000;

/** 같은 process 안에서 이미 띄운 stack. Electron 이 `startStack` 뒤에 `stopStack` 을 부를 때 쓴다. */
const ownedStacks = new Map<string, Supervisor>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveDataDir(dataDir: string | undefined, env: NodeJS.ProcessEnv): string {
  return path.resolve(dataDir?.trim() || defaultDataDir(env));
}

export function logDir(options: Pick<SupervisorOptions, 'dataDir'> = {}): string {
  return dataPaths(resolveDataDir(options.dataDir, process.env)).logs;
}

function controlUrl(
  state: Pick<StackState, 'host' | 'proxyPort' | 'tlsFingerprint'>,
  suffix: string,
): string {
  const scheme = state.tlsFingerprint ? 'https' : 'http';
  return `${scheme}://${connectableHost(state.host)}:${String(state.proxyPort)}${suffix}`;
}

/** control 경로에 GET 한 JSON. 연결이 안 되거나 지문이 다르면 `null`. */
async function controlJson(state: StackState): Promise<unknown> {
  if (!state.tlsFingerprint) return probeJson(controlUrl(state, CONTROL_PATH));
  const response = await pinnedHttpsRequest(
    { host: connectableHost(state.host), port: state.proxyPort },
    { method: 'GET', path: CONTROL_PATH, fingerprint: state.tlsFingerprint },
  );
  if (response?.status !== 200) return null;
  try {
    return JSON.parse(response.body) as unknown;
  } catch {
    return null;
  }
}

/** control 경로에 token 을 실어 POST 한 status. 연결이 안 되거나 지문이 다르면 `null`. */
async function controlStop(state: StackState): Promise<number | null> {
  const headers = { [CONTROL_TOKEN_HEADER]: state.controlToken };
  if (!state.tlsFingerprint) return postEmpty(controlUrl(state, CONTROL_STOP_PATH), headers);
  const response = await pinnedHttpsRequest(
    { host: connectableHost(state.host), port: state.proxyPort },
    {
      method: 'POST',
      path: CONTROL_STOP_PATH,
      headers,
      fingerprint: state.tlsFingerprint,
      timeoutMs: 5_000,
    },
  );
  return response?.status ?? null;
}

/** state 가 가리키는 supervisor 의 proxy 가 답하고, 답한 pid 가 state 의 pid 와 같은가. */
async function proxyAnswers(state: StackState): Promise<boolean> {
  const body = await controlJson(state);
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as { pid?: unknown }).pid === state.supervisorPid
  );
}

function attachedHandle(url: string): OwnedStack {
  return { url, attached: true, stop: () => Promise.resolve(), closed: Promise.resolve() };
}

/**
 * 다른 supervisor `pid` 가 stack 을 다 띄울 때까지 기다린다. 그 supervisor 가 도중에 죽으면
 * `null` 이다.
 */
async function waitForAttach(
  stateFile: string,
  pid: number,
  timeoutMs: number,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return null;
    const state = await readState(stateFile);
    if (state !== null && state.supervisorPid === pid && (await proxyAnswers(state))) {
      return state.url;
    }
    await sleep(250);
  }
  throw new SupervisorError(
    'server_start_failed',
    `Another ARTEL supervisor (pid ${String(pid)}) is starting the stack in this data directory and did not become ready within ${String(Math.round(timeoutMs / 1000))} seconds.`,
  );
}

async function tryAcquireLock(lockFile: string): Promise<number | 'acquired'> {
  try {
    await fs.writeFile(lockFile, String(process.pid), { flag: 'wx', mode: 0o600 });
    return 'acquired';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const text = await fs.readFile(lockFile, 'utf8').catch(() => '');
  const holder = Number.parseInt(text.trim(), 10);
  return Number.isInteger(holder) ? holder : 0;
}

/**
 * supervisor 없이 남은 process 를 정리한다. supervisor 가 SIGKILL 로 죽었거나 기계가 잠들었다 깬
 * 경우다. postgres 는 `pg_ctl stop` 으로 멈춰야 다음 start 가 recovery 없이 뜬다.
 */
async function cleanupStale(state: StackState, paths: DataPaths, graceMs: number): Promise<void> {
  for (const service of ['agent-server', 'orchestration'] as const) {
    const pid = state.pids[service];
    if (pid !== null && pid !== process.pid) await stopProcessTree(pid, graceMs);
  }
  const postmaster = await postmasterPid(paths.pgdata);
  if (postmaster !== null && isPidAlive(postmaster)) {
    let stopped = false;
    try {
      const runtime = await loadRuntime(state.runtimeDir);
      const config = await readStackConfig(paths.configFile);
      if (config !== null) {
        stopped = await stopPostgres(
          runtime.executables.pg_ctl,
          paths.pgdata,
          postgresEnv({ runtime, paths, config, onLine: () => undefined }),
        );
      }
    } catch {
      stopped = false;
    }
    if (!stopped) await stopProcessTree(postmaster, graceMs);
  }
  await removeState(paths.stateFile);
}

/** 한 데이터 디렉터리의 stack 하나를 띄우고 지켜보다 멈춘다. */
class Supervisor {
  private readonly logs = new Map<LogFileName, RotatingLog>();
  private readonly states = emptyServiceStates();
  private readonly pids: Record<ServiceName, number | null> = {
    postgres: null,
    orchestration: null,
    'agent-server': null,
    proxy: null,
  };
  private readonly children = new Map<ServiceName, ChildProcess>();
  private readonly crashTimes = new Map<ServiceName, number[]>();
  private readonly restartTimers = new Set<NodeJS.Timeout>();
  private postgresFollower: FileFollower | null = null;
  private postgresWatch: NodeJS.Timeout | null = null;
  private proxy: RunningProxy | null = null;
  private runtime: RuntimeLayout | null = null;
  private config: StackConfig | null = null;
  private stopping = false;
  private stopPromise: Promise<void> | null = null;
  private stateWrites: Promise<void> = Promise.resolve();
  private closedResolve: () => void = () => undefined;
  readonly closed: Promise<void>;
  readonly controlToken = crypto.randomBytes(32).toString('hex');
  private readonly startedAt = new Date().toISOString();
  url = '';

  constructor(
    readonly paths: DataPaths,
    private readonly options: SupervisorOptions,
    private readonly timeouts: SupervisorTimeouts,
    private readonly restartPolicy: RestartPolicy,
    private readonly env: NodeJS.ProcessEnv,
  ) {
    this.closed = new Promise((resolve) => {
      this.closedResolve = resolve;
    });
  }

  private settings: StackSettings = effectiveSettings(null);
  private tlsMaterial: TlsMaterial | null = null;

  private get host(): string {
    return this.settings.host;
  }

  private log(name: LogFileName): RotatingLog {
    let log = this.logs.get(name);
    if (log === undefined) {
      log = new RotatingLog(logFilePath(this.paths.logs, name));
      this.logs.set(name, log);
    }
    return log;
  }

  private emit(event: SupervisorEvent): void {
    try {
      this.options.onEvent?.(event);
    } catch {
      // 받는 쪽의 오류가 supervisor 를 멈추게 두지 않는다.
    }
  }

  private supervisorLine(text: string): void {
    this.log('supervisor').write(`${new Date().toISOString()} ${text}`);
  }

  private serviceLine(service: ServiceName, line: string): void {
    if (service !== 'postgres') this.log(service).write(line);
    this.emit({ type: 'log', service, line });
  }

  private setState(service: ServiceName, state: ServiceState, detail?: string): void {
    this.states[service] = state;
    this.supervisorLine(`${service} ${state}${detail ? `: ${detail}` : ''}`);
    this.emit(
      detail === undefined
        ? { type: 'service', service, state }
        : { type: 'service', service, state, detail },
    );
    void this.persistState();
  }

  private persistState(): Promise<void> {
    if (this.stopping && this.stopPromise !== null) return this.stateWrites;
    const snapshot: StackState = {
      schemaVersion: 1,
      supervisorPid: process.pid,
      url: this.url,
      host: this.host,
      proxyPort: this.config?.ports.proxy ?? 0,
      tlsFingerprint: this.tlsMaterial?.fingerprint ?? null,
      runtimeDir: this.runtime?.runtimeDir ?? '',
      runtimeVersion: this.runtime?.manifest.version ?? '',
      startedAt: this.startedAt,
      controlToken: this.controlToken,
      pids: { ...this.pids },
      services: { ...this.states },
    };
    this.stateWrites = this.stateWrites
      .then(() => writeState(this.paths.stateFile, snapshot))
      .catch(() => undefined);
    return this.stateWrites;
  }

  private postgresContext(): PostgresContext {
    if (this.runtime === null || this.config === null) throw new Error('runtime not loaded');
    return {
      runtime: this.runtime,
      paths: this.paths,
      config: this.config,
      onLine: (line) => {
        this.log('postgres').write(line);
        this.emit({ type: 'log', service: 'postgres', line });
      },
    };
  }

  async start(): Promise<void> {
    const runtimeDir = resolveRuntimeDir(this.paths.dataDir, this.options.runtimeDir, this.env);
    this.runtime = await loadRuntime(runtimeDir);

    const savedConfig = await readStackConfig(this.paths.configFile);
    const pgdataExists = await fs
      .access(path.join(this.paths.pgdata, 'PG_VERSION'))
      .then(() => true)
      .catch(() => false);
    if (savedConfig === null && pgdataExists) {
      throw new SupervisorError(
        'server_start_failed',
        `${this.paths.configFile} is missing or unreadable, but ${this.paths.pgdata} already holds a database. The database password and secrets live only in that file, so the stack cannot start. Restore the file, or move ${this.paths.pgdata} away to start over with an empty database.`,
      );
    }
    const explicit = {
      host: this.options.host,
      port: this.options.port,
      publicUrl: this.options.publicUrl,
      tls: this.options.tls,
    };
    // 인증서는 start 마다 다시 읽는다. 갱신한 파일은 다음 start 부터 쓰이고, 떠 있는 동안은 바꾸지 않는다.
    const requested = effectiveSettings(savedConfig, explicit);
    this.tlsMaterial = await validateSettings(requested);
    // host 와 publicUrl 은 사용자가 정했을 때만 저장해, port 나 TLS 를 바꾸면 기본값이 따라 바뀌게 한다.
    const keptHost = this.options.host?.trim() ? requested.host : savedConfig?.host;
    const keptPublicUrl = this.options.publicUrl?.trim()
      ? requested.publicUrl
      : savedConfig?.publicUrl;
    this.config = await loadOrCreateStackConfig(this.paths.configFile, {
      proxyPort: this.options.port,
      host: requested.host,
      network: {
        ...(keptHost === undefined ? {} : { host: keptHost }),
        ...(keptPublicUrl === undefined ? {} : { publicUrl: keptPublicUrl }),
        ...(requested.tls === null ? {} : { tls: requested.tls }),
      },
    });
    // 저장된 port 가 쓰이고 있어 다른 port 로 옮겼을 수 있다. 기본 publicUrl 은 실제 port 를 따른다.
    this.settings = effectiveSettings(this.config);
    this.url = this.settings.publicUrl;
    const warning = plainTextWarning(this.settings);
    if (warning !== null) {
      this.supervisorLine(`warning: ${warning}`);
      this.emit({ type: 'warning', code: 'plain_text_exposure', message: warning });
    }
    this.supervisorLine(`starting ${this.url} with runtime ${runtimeDir}`);

    await prepareHome({
      runtimeHomeDir: this.runtime.homeDir,
      homeDir: this.paths.home,
      stampFile: this.paths.homeStamp,
      runtimeVersion: this.runtime.manifest.version,
      url: this.url,
    });
    await fs.mkdir(this.paths.storage, { recursive: true });
    await this.persistState();

    try {
      await this.startPostgres();
      await this.startChild('orchestration');
      await this.startChild('agent-server');
      await this.startProxyService();
    } catch (error) {
      await this.stop();
      throw error;
    }
    this.watchPostgres();
    await this.persistState();
    this.supervisorLine(`ready ${this.url}`);
    this.emit({ type: 'ready', url: this.url });
  }

  private async startPostgres(): Promise<void> {
    this.setState('postgres', 'starting');
    const context = this.postgresContext();
    const created = await ensureCluster(context);
    if (created) this.supervisorLine(`initdb created ${this.paths.pgdata}`);
    await writeSettings(context);
    const postgresLog = logFilePath(this.paths.logs, 'postgres-server');
    rotateIfLarge(postgresLog);
    this.postgresFollower?.stop();
    this.postgresFollower = followFile(postgresLog, (line) => {
      this.emit({ type: 'log', service: 'postgres', line });
    });
    await startPostgres(context);
    await this.waitUntil(
      'postgres',
      () => isPostgresReady(context),
      this.timeouts.postgresReadyMs,
      () => null,
    );
    await ensureDatabase(context);
    this.pids.postgres = await postmasterPid(this.paths.pgdata);
    this.setState('postgres', 'ready');
  }

  private commandFor(service: 'orchestration' | 'agent-server'): ServiceCommand {
    if (this.runtime === null || this.config === null) throw new Error('runtime not loaded');
    const context = {
      runtime: this.runtime,
      config: this.config,
      publicUrl: this.url,
      storageDir: this.paths.storage,
    };
    return service === 'orchestration'
      ? orchestrationCommand(context)
      : agentServerCommand(context);
  }

  private readinessProbe(service: 'orchestration' | 'agent-server'): () => Promise<boolean> {
    const ports = this.config?.ports;
    if (ports === undefined) throw new Error('config not loaded');
    if (service === 'orchestration') {
      // orchestration 에는 health route 가 없다. 401 이든 무엇이든 HTTP 로 답하면 떠 있는 것이다.
      const url = `http://127.0.0.1:${String(ports.orchestration)}/api/auth/me`;
      return async () => (await probeStatus(url)) !== null;
    }
    const url = `http://127.0.0.1:${String(ports.agentServer)}/health`;
    return async () => (await probeStatus(url)) === 200;
  }

  private async startChild(service: 'orchestration' | 'agent-server'): Promise<void> {
    this.setState(service, 'starting');
    const spec = this.commandFor(service);
    const child = spawnService({
      command: spec.command,
      args: spec.args,
      ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
      env: { ...this.env, ...spec.env },
      onLine: (line) => this.serviceLine(service, line),
    });
    this.children.set(service, child);
    this.pids[service] = child.pid ?? null;

    let exitReason: string | null = null;
    child.once('error', (error) => {
      exitReason = `could not be started: ${error.message}`;
    });
    child.once('exit', (code, signal) => {
      exitReason = `exited with ${signal ?? `code ${String(code)}`}`;
      if (this.children.get(service) === child) {
        this.children.delete(service);
        this.pids[service] = null;
        if (!this.stopping && this.states[service] === 'ready') {
          this.handleCrash(service, exitReason);
        }
      }
    });

    const timeoutMs =
      service === 'orchestration'
        ? this.timeouts.orchestrationReadyMs
        : this.timeouts.agentServerReadyMs;
    await this.waitUntil(service, this.readinessProbe(service), timeoutMs, () => exitReason);
    this.setState(service, 'ready');
  }

  private async startProxyService(): Promise<void> {
    if (this.config === null || this.runtime === null) throw new Error('config not loaded');
    this.setState('proxy', 'starting');
    try {
      this.proxy = await startProxy({
        host: this.host,
        port: this.config.ports.proxy,
        orchestrationPort: this.config.ports.orchestration,
        homeDir: this.paths.home,
        ...(this.tlsMaterial === null
          ? {}
          : { tls: { cert: this.tlsMaterial.cert, key: this.tlsMaterial.key } }),
        control: {
          pid: process.pid,
          token: this.controlToken,
          runtimeVersion: this.runtime.manifest.version,
          onStopRequested: () => {
            void this.stop();
          },
        },
        onError: (message) => this.serviceLine('proxy', message),
      });
    } catch (error) {
      throw new SupervisorError(
        'server_start_failed',
        `The proxy could not listen on ${this.host}:${String(this.config.ports.proxy)}: ${(error as Error).message}. See ${logFilePath(this.paths.logs, 'supervisor')}.`,
      );
    }
    this.pids.proxy = process.pid;
    this.setState('proxy', 'ready');
  }

  /**
   * `check` 가 참이 될 때까지 기다린다. `exited` 가 이유를 돌려주면 process 가 이미 끝났다는 뜻이라
   * 남은 시간을 다 기다리지 않고 바로 실패한다.
   */
  private async waitUntil(
    service: ServiceName,
    check: () => Promise<boolean>,
    timeoutMs: number,
    exited: () => string | null,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const logFile = logFilePath(this.paths.logs, service);
    while (Date.now() < deadline) {
      if (this.stopping) {
        throw new SupervisorError('server_start_failed', `Stopped while ${service} was starting.`);
      }
      const reason = exited();
      if (reason !== null) {
        throw new SupervisorError(
          'server_start_failed',
          `${service} ${reason} before it became ready. See ${logFile}.`,
        );
      }
      if (await check()) return;
      await sleep(250);
    }
    throw new SupervisorError(
      'server_start_failed',
      `${service} did not become ready within ${String(Math.round(timeoutMs / 1000))} seconds. See ${logFile}.`,
    );
  }

  /** postmaster 는 `pg_ctl` 이 띄워 child 가 아니므로 pid 를 주기적으로 본다. */
  private watchPostgres(): void {
    this.postgresWatch = setInterval(() => {
      if (this.stopping || this.states.postgres !== 'ready') return;
      if (!isPidAlive(this.pids.postgres)) {
        this.pids.postgres = null;
        this.handleCrash('postgres', 'postmaster is no longer running');
      }
    }, POSTGRES_WATCH_INTERVAL_MS);
    this.postgresWatch.unref();
  }

  /**
   * 10 분 안에 5 번까지 다시 띄운다. 그 이상이면 `crashed` 로 두고 손대지 않는다: 같은 이유로
   * 계속 죽는 process 를 끝없이 다시 띄우면 log 만 쌓인다.
   */
  private handleCrash(service: ServiceName, reason: string): void {
    const now = Date.now();
    const recent = (this.crashTimes.get(service) ?? []).filter(
      (time) => now - time < this.restartPolicy.windowMs,
    );
    if (recent.length >= this.restartPolicy.maxRestarts) {
      this.crashTimes.set(service, recent);
      this.setState(
        service,
        'crashed',
        `${reason}; restarted ${String(recent.length)} times in ${String(Math.round(this.restartPolicy.windowMs / 60_000))} minutes, giving up. See ${logFilePath(this.paths.logs, service)}`,
      );
      return;
    }
    const delay = this.restartPolicy.baseDelayMs * 2 ** recent.length;
    recent.push(now);
    this.crashTimes.set(service, recent);
    this.setState(service, 'starting', `${reason}; restarting in ${String(delay)} ms`);
    const timer = setTimeout(() => {
      this.restartTimers.delete(timer);
      void this.restart(service);
    }, delay);
    this.restartTimers.add(timer);
  }

  private async restart(service: ServiceName): Promise<void> {
    if (this.stopping) return;
    try {
      if (service === 'postgres') {
        await this.startPostgres();
      } else if (service === 'orchestration' || service === 'agent-server') {
        await this.startChild(service);
      }
    } catch (error) {
      if (this.stopping) return;
      const pid = this.pids[service];
      if (service !== 'postgres' && pid !== null)
        await stopProcessTree(pid, this.timeouts.stopGraceMs);
      this.handleCrash(service, (error as Error).message);
    }
  }

  stop(): Promise<void> {
    if (this.stopPromise === null) {
      this.stopping = true;
      this.stopPromise = this.stopAll();
    }
    return this.stopPromise;
  }

  /** 띄운 순서의 반대로 멈춘다: proxy, agent-server, orchestration, postgres. */
  private async stopAll(): Promise<void> {
    for (const timer of this.restartTimers) clearTimeout(timer);
    this.restartTimers.clear();
    if (this.postgresWatch !== null) clearInterval(this.postgresWatch);

    if (this.proxy !== null) {
      await this.proxy.close();
      this.proxy = null;
    }
    this.markStopped('proxy');

    for (const service of ['agent-server', 'orchestration'] as const) {
      const pid = this.pids[service];
      if (pid !== null) await stopProcessTree(pid, this.timeouts.stopGraceMs);
      this.children.delete(service);
      this.markStopped(service);
    }

    if (this.runtime !== null && this.config !== null) {
      const context = this.postgresContext();
      const stopped = await stopPostgres(
        this.runtime.executables.pg_ctl,
        this.paths.pgdata,
        postgresEnv(context),
        context.onLine,
      );
      const pid = this.pids.postgres ?? (await postmasterPid(this.paths.pgdata));
      if (!stopped && pid !== null) await stopProcessTree(pid, this.timeouts.stopGraceMs);
    }
    this.markStopped('postgres');
    this.postgresFollower?.stop();

    await this.stateWrites;
    await removeState(this.paths.stateFile);
    await fs.rm(path.join(this.paths.dataDir, LOCK_FILE), { force: true });
    this.supervisorLine('stopped');
    for (const log of this.logs.values()) log.close();
    ownedStacks.delete(this.paths.dataDir);
    this.closedResolve();
  }

  private markStopped(service: ServiceName): void {
    this.pids[service] = null;
    if (this.states[service] === 'stopped') return;
    this.states[service] = 'stopped';
    this.supervisorLine(`${service} stopped`);
    this.emit({ type: 'service', service, state: 'stopped' });
  }
}

/**
 * stack 을 띄운다. 같은 데이터 디렉터리에 살아 있는 supervisor 가 있고 그 proxy 가 답하면 아무것도
 * 띄우지 않고 `{ attached: true }` 를 돌려준다.
 */
export function startStack(options: SupervisorOptions = {}): Promise<RunningStack> {
  return startStackWithInternals(options, {});
}

export async function startStackWithInternals(
  options: SupervisorOptions,
  internals: SupervisorInternals,
): Promise<OwnedStack> {
  const env = internals.env ?? process.env;
  const timeouts = { ...DEFAULT_TIMEOUTS, ...internals.timeouts };
  const restartPolicy = { ...DEFAULT_RESTART_POLICY, ...internals.restartPolicy };
  const dataDir = resolveDataDir(options.dataDir, env);
  const paths = dataPaths(dataDir);

  const own = ownedStacks.get(dataDir);
  if (own !== undefined) return attachedHandle(own.url);

  if (!internals.skipPrivilegeCheck) assertNotPrivileged();
  const target = internals.target === undefined ? currentTarget() : internals.target;
  if (target === null) {
    throw new SupervisorError(
      'server_unsupported_platform',
      `No ARTEL runtime is built for ${process.platform}-${process.arch}.`,
    );
  }

  await fs.mkdir(paths.logs, { recursive: true });
  const lockFile = path.join(dataDir, LOCK_FILE);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const state = await readState(paths.stateFile);
    if (state !== null && state.supervisorPid !== process.pid && isPidAlive(state.supervisorPid)) {
      const url = await waitForAttach(paths.stateFile, state.supervisorPid, timeouts.attachMs);
      if (url !== null) return attachedHandle(url);
      continue;
    }

    const lock = await tryAcquireLock(lockFile);
    if (lock !== 'acquired') {
      if (lock !== process.pid && isPidAlive(lock)) {
        const url = await waitForAttach(paths.stateFile, lock, timeouts.attachMs);
        if (url !== null) return attachedHandle(url);
      }
      // 잠근 supervisor 가 없다. 남은 process 를 정리하고 다시 잠근다.
      if (state !== null) await cleanupStale(state, paths, timeouts.stopGraceMs);
      await fs.rm(lockFile, { force: true });
      continue;
    }

    if (state !== null) await cleanupStale(state, paths, timeouts.stopGraceMs);
    const supervisor = new Supervisor(paths, options, timeouts, restartPolicy, env);
    ownedStacks.set(dataDir, supervisor);
    try {
      await supervisor.start();
    } catch (error) {
      ownedStacks.delete(dataDir);
      await fs.rm(lockFile, { force: true });
      throw error;
    }
    return {
      url: supervisor.url,
      attached: false,
      stop: () => supervisor.stop(),
      closed: supervisor.closed,
    };
  }
  throw new SupervisorError(
    'server_start_failed',
    `Could not take the supervisor lock at ${lockFile}. Remove it if no ARTEL supervisor is running.`,
  );
}

/**
 * 이 데이터 디렉터리의 stack 을 멈춘다. 다른 process 의 supervisor 에게는 `state.json` 의
 * `controlToken` 으로 종료를 요청한다. Windows 에는 SIGTERM 이 없어서 signal 대신 HTTP 를 쓴다.
 */
export function stopStack(options: Pick<SupervisorOptions, 'dataDir'> = {}): Promise<void> {
  return stopStackWithInternals(options, {});
}

export async function stopStackWithInternals(
  options: Pick<SupervisorOptions, 'dataDir'>,
  internals: SupervisorInternals,
): Promise<void> {
  const env = internals.env ?? process.env;
  const timeouts = { ...DEFAULT_TIMEOUTS, ...internals.timeouts };
  const dataDir = resolveDataDir(options.dataDir, env);
  const paths = dataPaths(dataDir);

  const own = ownedStacks.get(dataDir);
  if (own !== undefined) {
    await own.stop();
    return;
  }

  const state = await readState(paths.stateFile);
  if (state === null) return;
  const pid = state.supervisorPid;
  if (isPidAlive(pid)) {
    const status = await controlStop(state);
    if (status !== 202 && process.platform !== 'win32') {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // 이미 끝났다.
      }
    }
    // supervisor 가 child 를 다 멈추는 시간까지 기다린다.
    const deadline = Date.now() + timeouts.stopGraceMs * 3 + 60_000;
    while (Date.now() < deadline && isPidAlive(pid)) {
      if ((await readState(paths.stateFile)) === null) break;
      await sleep(250);
    }
    if ((await readState(paths.stateFile)) === null) return;
    if (isPidAlive(pid)) await stopProcessTree(pid, timeouts.stopGraceMs);
  }
  const remaining = await readState(paths.stateFile);
  if (remaining !== null) await cleanupStale(remaining, paths, timeouts.stopGraceMs);
  await fs.rm(path.join(dataDir, LOCK_FILE), { force: true });
  if ((await readState(paths.stateFile)) !== null) {
    throw new SupervisorError(
      'server_stop_failed',
      `The ARTEL stack in ${dataDir} did not stop. See ${logFilePath(paths.logs, 'supervisor')}.`,
    );
  }
}

/** `state.json` 이 살아 있는 supervisor 를 가리킬 때만 `running` 이다. */
export async function stackStatus(
  options: Pick<SupervisorOptions, 'dataDir'> = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<StackStatus> {
  const paths = dataPaths(resolveDataDir(options.dataDir, env));
  const state = await readState(paths.stateFile);
  if (state === null || !isPidAlive(state.supervisorPid)) {
    return { running: false, services: emptyServiceStates() };
  }
  const services = emptyServiceStates();
  for (const service of SERVICE_NAMES) {
    services[service] = state.services[service] ?? 'stopped';
  }
  return { running: true, url: state.url, pid: state.supervisorPid, services };
}
