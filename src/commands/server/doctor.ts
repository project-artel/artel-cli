import { EXIT_FAILURE, EXIT_OK } from '../../exit.js';
import type { ServerDoctorPayload } from '../../output/contract.js';
import { writeJsonPayload, type OutputSink } from '../../output/envelope.js';
import { runDoctor } from '../../server/doctor.js';
import { commandDataDir } from './shared.js';

export interface ServerDoctorOptions {
  json: boolean;
}

/** `fail` 인 검사가 하나라도 있으면 exit code 1 이다. `warn` 만 있으면 0 이다. */
export async function runServerDoctor(
  options: ServerDoctorOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const report = await runDoctor({ dataDir: commandDataDir(env), env });
  const payload: ServerDoctorPayload = {
    ok: report.checks.every((check) => check.status !== 'fail'),
    dataDir: report.dataDir,
    runtimeDir: report.runtimeDir,
    checks: report.checks,
  };
  if (options.json) {
    writeJsonPayload(sink, payload);
  } else {
    for (const check of payload.checks) {
      sink.out(
        `${check.status.toUpperCase().padEnd(4)}  ${check.name.padEnd(10)}  ${check.detail}`,
      );
    }
  }
  return payload.ok ? EXIT_OK : EXIT_FAILURE;
}
