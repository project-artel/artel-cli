import type { LoginPayload, LogoutPayload, StatusPayload } from './contract.js';
import type { OutputSink } from './envelope.js';

/**
 * Windows 는 POSIX mode bit 를 강제하지 않으므로 0600 을 주장하지 않는다. 파일은 사용자
 * 프로필 ACL 로 보호된다고만 말한다.
 */
function describeMode(mode: string | null): string {
  return mode === null ? 'protected by the user profile ACL' : `mode ${mode}`;
}

export function printLogin(sink: OutputSink, payload: LoginPayload, overwrote: boolean): void {
  sink.out(
    `Signed in. Credentials written to ${payload.credentialsPath} (${describeMode(payload.mode)}).`,
  );
  if (overwrote) {
    sink.out('An existing credentials file was overwritten.');
  }
  sink.out(`  token name   ${payload.tokenName}`);
  sink.out(`  token id     ${payload.tokenId}`);
  sink.out(`  fingerprint  ${payload.fingerprint}`);
  sink.out(`  expires at   ${payload.expiresAt ?? 'never'}`);
  sink.out(`  api base url ${payload.apiBaseUrl}`);
}

export function printStatus(sink: OutputSink, payload: StatusPayload): void {
  if (!payload.authenticated) {
    sink.out('Not signed in.');
    sink.out(`  credentials file  ${payload.credentialsPath} (missing)`);
    sink.out(describeEnvVar(payload.envVarState));
    sink.out('Run "artel auth login", or set ARTEL_TOKEN.');
    return;
  }

  sink.out(payload.source === 'env' ? 'Signed in with ARTEL_TOKEN.' : 'Signed in.');
  sink.out(`  fingerprint       ${payload.fingerprint ?? '-'}`);
  sink.out(
    `  credentials file  ${payload.credentialsPath} (${payload.credentialsFileExists ? describeMode(payload.mode) : 'missing'})`,
  );
  sink.out(describeEnvVar(payload.envVarState));
  if (payload.source === 'file') {
    sink.out(`  token name        ${payload.tokenName ?? '-'}`);
    sink.out(`  token id          ${payload.tokenId ?? '-'}`);
    sink.out(`  expires at        ${payload.expiresAt ?? 'never'}`);
    sink.out(`  api base url      ${payload.apiBaseUrl ?? '-'}`);
  }
}

export function printLogout(sink: OutputSink, payload: LogoutPayload): void {
  sink.out(
    payload.removed
      ? `Removed the credentials file at ${payload.credentialsPath}.`
      : `No credentials file at ${payload.credentialsPath}; nothing to remove.`,
  );
  sink.out(
    'This did not revoke anything on the server. The token stays valid until it expires or you revoke it in the console.',
  );
}

function describeEnvVar(state: StatusPayload['envVarState']): string {
  switch (state) {
    case 'used':
      return '  ARTEL_TOKEN       set, and used as the credential';
    case 'empty':
      return '  ARTEL_TOKEN       set but empty, so it was ignored';
    case 'unset':
      return '  ARTEL_TOKEN       not set';
  }
}
