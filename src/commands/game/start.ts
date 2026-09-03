import { resolveConfig } from '../../config.js';
import { resolveCredential } from '../../credentials/resolve.js';
import { CliError } from '../../errors.js';
import {
  defaultGameStartDeps,
  runGameStartFlow,
  type GameStartDeps,
} from '../../game/start-flow.js';
import type { GameStartPayload } from '../../output/contract.js';
import { writeJsonPayload, type OutputSink } from '../../output/envelope.js';
import { printGameStart } from '../../output/human.js';

export interface GameStartOptions {
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

/** 사용자는 CLI 자격 증명만 쥐고 있으면 된다 — SDK token 은 `game/start-flow.ts` 가 스스로 낸다. */
export async function runGameStart(
  options: GameStartOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
  makeDeps: (notify: (message: string) => void) => GameStartDeps = (notify) =>
    defaultGameStartDeps(notify, env),
): Promise<void> {
  const config = resolveConfig(env, {
    apiBaseUrl: options.apiUrl,
    consoleBaseUrl: options.consoleUrl,
  });

  // 진행 상황은 stderr 로 간다. `--json` 을 켠 쪽의 stdout 에는 payload 한 줄만 남아야 한다.
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

  const result = await runGameStartFlow(
    {
      apiBaseUrl: config.apiBaseUrl,
      consoleBaseUrl: config.consoleBaseUrl,
      cliToken: resolution.credential.token,
      build: options.build,
      projectId: options.project,
      width: options.width,
      height: options.height,
      registrationTimeoutMs: options.timeoutSeconds * 1_000,
      processEnv: env,
    },
    makeDeps(notify),
  );

  const payload: GameStartPayload = {
    launched: true,
    build: options.build,
    projectId: result.instance.projectId,
    instanceId: result.instance.id,
    registeredAt: result.instance.lastConnectedAt,
    serverAddress: result.serverAddress,
    secure: result.secure,
    frontendUrl: config.consoleBaseUrl,
    logFilePath: result.logFilePath,
    pid: result.pid,
  };

  if (options.json) {
    writeJsonPayload(sink, payload);
    return;
  }
  printGameStart(sink, payload);
}
