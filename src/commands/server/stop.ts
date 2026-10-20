import type { ServerStopPayload } from '../../output/contract.js';
import { writeJsonPayload, type OutputSink } from '../../output/envelope.js';
import { stackStatus, stopStackWithInternals } from '../../server/supervisor.js';
import { commandDataDir, withSupervisorErrors } from './shared.js';

export interface ServerStopOptions {
  json: boolean;
}

/** 떠 있지 않아도 성공이다. 멈춰 있기를 바란 상태가 이미 그렇다. */
export async function runServerStop(
  options: ServerStopOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const dataDir = commandDataDir(env);
  const before = await stackStatus({ dataDir }, env);
  await withSupervisorErrors(() => stopStackWithInternals({ dataDir }, { env }));

  const payload: ServerStopPayload = { wasRunning: before.running, dataDir };
  if (options.json) {
    writeJsonPayload(sink, payload);
    return;
  }
  sink.out(before.running ? 'ARTEL stopped.' : 'ARTEL was not running.');
}
