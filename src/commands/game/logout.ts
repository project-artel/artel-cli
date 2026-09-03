import { resolveConfig } from '../../config.js';
import { resolveCredential } from '../../credentials/resolve.js';
import { CliError } from '../../errors.js';
import {
  defaultGameLogoutDeps,
  runGameLogoutFlow,
  type GameLogoutDeps,
} from '../../game/logout-flow.js';
import type { GameLogoutPayload } from '../../output/contract.js';
import { writeJsonPayload, type OutputSink } from '../../output/envelope.js';
import { printGameLogout } from '../../output/human.js';

export interface GameLogoutOptions {
  json: boolean;
  project: string;
  build: string;
  width: number;
  height: number;
  timeoutSeconds: number;
  /** `--api-url`. 있으면 `ARTEL_API_BASE_URL` 보다 이긴다. */
  apiUrl?: string | undefined;
  /** `--console-url`. 있으면 `ARTEL_CONSOLE_BASE_URL` 보다 이긴다. */
  consoleUrl?: string | undefined;
}

export async function runGameLogout(
  options: GameLogoutOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
  makeDeps: (notify: (message: string) => void) => GameLogoutDeps = (notify) =>
    defaultGameLogoutDeps(notify, env),
): Promise<void> {
  const config = resolveConfig(env, {
    apiBaseUrl: options.apiUrl,
    consoleBaseUrl: options.consoleUrl,
  });

  const notify = (message: string): void => {
    sink.err(message);
  };

  const resolution = await resolveCredential(env);
  if (resolution.credential === null) {
    throw new CliError(
      'no_credential',
      'Not signed in. Run "artel auth login" first, or set ARTEL_TOKEN.',
    );
  }

  const result = await runGameLogoutFlow(
    {
      apiBaseUrl: config.apiBaseUrl,
      consoleBaseUrl: config.consoleBaseUrl,
      cliToken: resolution.credential.token,
      build: options.build,
      projectId: options.project,
      width: options.width,
      height: options.height,
      logoutTimeoutMs: options.timeoutSeconds * 1_000,
      processEnv: env,
    },
    makeDeps(notify),
  );

  const payload: GameLogoutPayload = {
    build: options.build,
    projectId: options.project,
    serverAddress: result.serverAddress,
    secure: result.secure,
    frontendUrl: config.consoleBaseUrl,
    logFilePath: result.logFilePath,
    pid: result.pid,
    exitCode: result.exitCode,
    signal: result.signal,
  };

  if (options.json) {
    writeJsonPayload(sink, payload);
    return;
  }
  printGameLogout(sink, payload);
}
