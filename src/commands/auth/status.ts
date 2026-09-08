import { reportOf, resolveCredential } from '../../credentials/resolve.js';
import type { StatusPayload } from '../../output/contract.js';
import { writeJsonPayload, type OutputSink } from '../../output/envelope.js';
import { printStatus } from '../../output/human.js';
import { readCliVersion } from '../../version.js';

export interface AuthStatusOptions {
  json: boolean;
}

/**
 * 자격 증명이 아예 없어도 exit code 는 0 이다. 보고에 성공했으니 성공이다 —
 * `set -e` 스크립트가 여기서 죽으면 안 된다.
 */
export async function runAuthStatus(
  options: AuthStatusOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const resolution = await resolveCredential(env);
  const report = reportOf(resolution);

  const payload: StatusPayload = {
    cliVersion: readCliVersion(),
    authenticated: report.authenticated,
    source: report.source,
    envVarState: resolution.envVarState,
    credentialsPath: report.credentialsPath,
    credentialsFileExists: report.credentialsFileExists,
    mode: report.mode,
    fingerprint: report.fingerprint,
    tokenId: report.tokenId,
    tokenName: report.tokenName,
    expiresAt: report.expiresAt,
    apiBaseUrl: report.apiBaseUrl,
  };

  if (options.json) {
    writeJsonPayload(sink, payload);
    return;
  }
  printStatus(sink, payload);
}
