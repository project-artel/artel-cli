import { CliError } from '../../errors.js';
import type { ServerInstallPayload } from '../../output/contract.js';
import { writeJsonPayload, type OutputSink } from '../../output/envelope.js';
import { installRuntime } from '../../server/install.js';
import { currentTarget, RUNTIME_VERSION } from '../../server/paths.js';
import {
  commandDataDir,
  downloadProgressReporter,
  withSupervisorErrors,
  type ServerDownloadDeps,
} from './shared.js';

export interface ServerInstallOptions {
  json: boolean;
  version?: string | undefined;
}

export type ServerInstallDeps = ServerDownloadDeps;

export async function runServerInstall(
  options: ServerInstallOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
  deps: ServerInstallDeps = {},
): Promise<void> {
  const target = currentTarget();
  if (target === null) {
    throw new CliError(
      'server_unsupported_platform',
      `No ARTEL runtime is built for ${process.platform}-${process.arch}.`,
    );
  }
  const version = options.version?.trim() || RUNTIME_VERSION;
  const progress = downloadProgressReporter(sink);
  const result = await withSupervisorErrors(() =>
    installRuntime({
      version,
      target,
      dataDir: commandDataDir(env),
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      ...(deps.baseUrl === undefined ? {} : { baseUrl: deps.baseUrl }),
      onProgress: progress.message,
      // `--json` 이어도 stderr 의 진행 줄은 그대로 둔다. 이 명령은 원래 그렇게 동작했다.
      onDownloadProgress: progress.bytes,
    }),
  ).finally(() => progress.done());

  const payload: ServerInstallPayload = {
    version: result.version,
    target: result.target,
    runtimeDir: result.runtimeDir,
    alreadyInstalled: result.alreadyInstalled,
    sha256: result.sha256,
  };
  if (options.json) {
    writeJsonPayload(sink, payload);
    return;
  }
  sink.out(
    result.alreadyInstalled
      ? `Runtime ${result.version} for ${result.target} is already installed at ${result.runtimeDir}.`
      : `Installed runtime ${result.version} for ${result.target} at ${result.runtimeDir}.`,
  );
  sink.out('Start the stack with "artel server start".');
}
