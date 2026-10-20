import type { StackConfig } from './config-file.js';
import type { RuntimeLayout } from './manifest.js';

/** orchestration 의 JVM 옵션. 세 process 가 한 기계에 같이 뜨므로 heap 을 작게 잡는다. */
export const ORCHESTRATION_JVM_OPTIONS = ['-Xmx512m', '-XX:+UseSerialGC'] as const;

export interface ServiceCommand {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
}

export interface ServiceContext {
  runtime: RuntimeLayout;
  config: StackConfig;
  publicUrl: string;
  storageDir: string;
}

/** 공유 계약 1절의 orchestration 표. 값 하나라도 바꾸려면 계약을 먼저 바꾼다. */
export function orchestrationCommand(context: ServiceContext): ServiceCommand {
  const { config, runtime, publicUrl, storageDir } = context;
  const { ports } = config;
  return {
    command: runtime.executables.java,
    args: [...ORCHESTRATION_JVM_OPTIONS, '-jar', runtime.orchestrationJar],
    env: {
      ARTEL_STORE: 'postgres',
      ARTEL_STORAGE: 'filesystem',
      ARTEL_STORAGE_DIR: storageDir,
      SERVER_PORT: String(ports.orchestration),
      ARTEL_INTERNAL_API_PORT: String(ports.orchestrationInternal),
      DB_HOST: '127.0.0.1',
      DB_PORT: String(ports.postgres),
      DB_NAME: 'artel',
      DB_USERNAME: 'artel',
      DB_PASSWORD: config.dbPassword,
      DB_SSL_MODE: 'disable',
      ARTEL_AGENT_BASE_URL: `http://127.0.0.1:${String(ports.agentServer)}/internal`,
      ARTEL_AGENT_WS_BASE_URL: `ws://127.0.0.1:${String(ports.agentServer)}/internal`,
      ARTEL_HOME_URL: publicUrl,
      ARTEL_ALLOWED_ORIGINS: publicUrl,
      ARTEL_JWT_SECRET: config.jwtSecret,
      ARTEL_SECRETS_KEY: config.secretsKey,
      ARTEL_SECURE_COOKIE: 'false',
      ARTEL_SIGNUP_OPEN: 'false',
      ARTEL_GITHUB_SIGNUP_OPEN: 'false',
      LOGGING_LEVEL_ORG_SPRINGFRAMEWORK_WEB: 'INFO',
      LOGGING_LEVEL_ORG_SPRINGFRAMEWORK_WEB_REACTIVE: 'INFO',
    },
  };
}

/** 공유 계약 1절의 agent-server 표. */
export function agentServerCommand(context: ServiceContext): ServiceCommand {
  const { config, runtime } = context;
  const { ports } = config;
  return {
    command: runtime.executables.python,
    args: [
      '-m',
      'uvicorn',
      'app.main:app',
      '--host',
      '127.0.0.1',
      '--port',
      String(ports.agentServer),
    ],
    cwd: runtime.agentServerDir,
    env: {
      SESSION_STORE: 'memory',
      APP_PORT: String(ports.agentServer),
      APP_ENV: 'production',
      ORCHESTRATION_BASE_URL: `http://127.0.0.1:${String(ports.orchestrationInternal)}`,
      LANGSMITH_TRACING: 'false',
    },
  };
}

/**
 * `postgresql.conf` 가 include 하는 설정. `pg_ctl -o` 로 넘기면 macOS 의
 * `Application Support` 처럼 공백이 든 경로를 shell 인용으로 다시 감싸야 해서 파일에 쓴다.
 */
export function postgresSettings(options: { port: number; socketDir: string | null }): string {
  const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`;
  return [
    '# Written by the artel supervisor on every start. Do not edit.',
    `listen_addresses = ${quote('127.0.0.1')}`,
    `port = ${String(options.port)}`,
    `shared_buffers = ${quote('64MB')}`,
    `unix_socket_directories = ${quote(options.socketDir ?? '')}`,
    '',
  ].join('\n');
}
