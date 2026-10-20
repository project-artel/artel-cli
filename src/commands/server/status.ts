import type { ServerStatusPayload } from '../../output/contract.js';
import { writeJsonPayload, type OutputSink } from '../../output/envelope.js';
import { dataPaths } from '../../server/paths.js';
import { SERVICE_NAMES } from '../../server/state-file.js';
import { stackStatus } from '../../server/supervisor.js';
import { commandDataDir } from './shared.js';

export interface ServerStatusOptions {
  json: boolean;
}

/** 떠 있지 않아도 exit code 는 0 이다. 보고에 성공했으니 성공이다. */
export async function runServerStatus(
  options: ServerStatusOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const dataDir = commandDataDir(env);
  const status = await stackStatus({ dataDir }, env);
  const payload: ServerStatusPayload = {
    running: status.running,
    url: status.url ?? null,
    pid: status.pid ?? null,
    services: status.services,
    dataDir,
    logDir: dataPaths(dataDir).logs,
  };
  if (options.json) {
    writeJsonPayload(sink, payload);
    return;
  }
  sink.out(
    payload.running
      ? `ARTEL is running at ${payload.url ?? '?'} (supervisor pid ${String(payload.pid ?? '?')})`
      : 'ARTEL is not running.',
  );
  for (const service of SERVICE_NAMES) {
    sink.out(`  ${service.padEnd(14)} ${payload.services[service]}`);
  }
  sink.out(`  data dir       ${payload.dataDir}`);
  sink.out(`  logs           ${payload.logDir}`);
}
