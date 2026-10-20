import { CliError, UsageError } from '../../errors.js';
import type { ServerConfigPayload } from '../../output/contract.js';
import { writeJsonPayload, type OutputSink } from '../../output/envelope.js';
import { dataPaths } from '../../server/paths.js';
import {
  plainTextWarning,
  readStackSettings,
  writeStackSettings,
  type StackSettings,
} from '../../server/stack-settings.js';
import { stackStatus } from '../../server/supervisor.js';
import { commandDataDir, withSupervisorErrors } from './shared.js';

export interface ServerConfigOptions {
  json: boolean;
}

export interface ServerConfigSetOptions extends ServerConfigOptions {
  host?: string | undefined;
  port?: number | undefined;
  publicUrl?: string | undefined;
  tlsCert?: string | undefined;
  tlsKey?: string | undefined;
  /** `--no-tls`. */
  noTls: boolean;
}

async function report(
  options: ServerConfigOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv,
  settings: StackSettings,
  changed: boolean,
): Promise<void> {
  const dataDir = commandDataDir(env);
  const status = await stackStatus({ dataDir }, env);
  const warning = plainTextWarning(settings);
  const payload: ServerConfigPayload = {
    host: settings.host,
    port: settings.port,
    publicUrl: settings.publicUrl,
    tls: settings.tls,
    dataDir,
    configFile: dataPaths(dataDir).configFile,
    changed,
    running: status.running,
    restartRequired: changed && status.running,
    warnings: warning === null ? [] : [warning],
  };
  if (options.json) {
    writeJsonPayload(sink, payload);
    return;
  }
  sink.out(`  host           ${payload.host}`);
  sink.out(`  port           ${String(payload.port)}`);
  sink.out(`  public URL     ${payload.publicUrl}`);
  sink.out(
    payload.tls === null
      ? '  TLS            off'
      : `  TLS            certificate ${payload.tls.certFile}\n                 key         ${payload.tls.keyFile}`,
  );
  sink.out(`  config file    ${payload.configFile}`);
  for (const line of payload.warnings) sink.err(`warning: ${line}`);
  if (changed) {
    sink.out(
      payload.restartRequired
        ? 'Saved. ARTEL is running with the old settings; they apply after "artel server stop" and "artel server start".'
        : 'Saved. The settings apply on the next "artel server start".',
    );
  }
}

/** 저장된 설정을 보여 준다. stack 이 한 번도 뜨지 않았으면 기본값이다. */
export async function runServerConfig(
  options: ServerConfigOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const settings = await readStackSettings({ dataDir: commandDataDir(env) });
  await report(options, sink, env, settings, false);
}

/** 고른 값만 바꿔 `config.json` 에 쓴다. 떠 있는 stack 은 건드리지 않는다. */
export async function runServerConfigSet(
  options: ServerConfigSetOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const wantsTls = options.tlsCert !== undefined || options.tlsKey !== undefined;
  if ((options.tlsCert === undefined) !== (options.tlsKey === undefined)) {
    throw new CliError(
      'server_settings_invalid',
      '--tls-cert and --tls-key go together: give both files or neither.',
    );
  }
  if (options.noTls && wantsTls) {
    throw new CliError(
      'server_settings_invalid',
      '--no-tls cannot be combined with --tls-cert and --tls-key.',
    );
  }
  const changes: Partial<StackSettings> = {};
  if (options.host !== undefined) changes.host = options.host;
  if (options.port !== undefined) changes.port = options.port;
  if (options.publicUrl !== undefined) changes.publicUrl = options.publicUrl;
  if (options.noTls) changes.tls = null;
  if (options.tlsCert !== undefined && options.tlsKey !== undefined) {
    changes.tls = { certFile: options.tlsCert, keyFile: options.tlsKey };
  }
  if (Object.keys(changes).length === 0) {
    throw new UsageError(
      'Nothing to change. Give --host, --port, --public-url, --tls-cert with --tls-key, or --no-tls.',
    );
  }
  const settings = await withSupervisorErrors(() =>
    writeStackSettings(changes, { dataDir: commandDataDir(env) }),
  );
  await report(options, sink, env, settings, true);
}
