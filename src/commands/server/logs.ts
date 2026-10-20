import { UsageError } from '../../errors.js';
import type { OutputSink } from '../../output/envelope.js';
import {
  followFile,
  LOG_FILE_NAMES,
  logFilePath,
  readLastLines,
  type LogFileName,
} from '../../server/logs.js';
import { dataPaths } from '../../server/paths.js';
import { commandDataDir } from './shared.js';

export interface ServerLogsOptions {
  service?: string | undefined;
  follow: boolean;
  lines: number;
  /** `--follow` 를 끝내는 signal. 없으면 Ctrl-C 까지 돈다. */
  signal?: AbortSignal;
}

export function parseLogService(value: string | undefined): LogFileName | null {
  if (value === undefined) return null;
  if ((LOG_FILE_NAMES as readonly string[]).includes(value)) return value as LogFileName;
  throw new UsageError(`Unknown service "${value}". Choose one of: ${LOG_FILE_NAMES.join(', ')}.`);
}

/** service 를 고르지 않으면 모든 log 를 `[service]` 를 앞에 붙여 보인다. log 는 `--json` 이 없다. */
export async function runServerLogs(
  options: ServerLogsOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const chosen = parseLogService(options.service);
  const services = chosen === null ? LOG_FILE_NAMES : [chosen];
  const logs = dataPaths(commandDataDir(env)).logs;
  const prefix = (service: LogFileName): string => (chosen === null ? `[${service}] ` : '');

  for (const service of services) {
    for (const line of readLastLines(logFilePath(logs, service), options.lines)) {
      sink.out(`${prefix(service)}${line}`);
    }
  }
  if (!options.follow) return;

  const followers = services.map((service) =>
    followFile(logFilePath(logs, service), (line) => sink.out(`${prefix(service)}${line}`)),
  );
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      for (const follower of followers) follower.stop();
      process.off('SIGINT', finish);
      resolve();
    };
    // follower 의 timer 는 unref 라서, 이것이 없으면 process 가 바로 끝난다.
    const keepAlive = setInterval(() => undefined, 60_000);
    options.signal?.addEventListener('abort', () => {
      clearInterval(keepAlive);
      finish();
    });
    process.once('SIGINT', () => {
      clearInterval(keepAlive);
      finish();
    });
  });
}
