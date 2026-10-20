/**
 * supervisor 가 던지는 실패. supervisor 는 commander 와 `CliError` 를 모르는 채로 Electron 에서도
 * 쓰이므로 자기 오류 type 을 가진다. `artel server` 명령이 `code` 를 보고 `CliError` 로 옮긴다.
 */
export type SupervisorErrorCode =
  | 'server_runtime_missing'
  | 'server_runtime_invalid'
  | 'server_privileged'
  | 'server_port_in_use'
  | 'server_start_failed'
  | 'server_stop_failed'
  | 'server_install_failed'
  | 'server_checksum_mismatch'
  | 'server_unsupported_platform';

export class SupervisorError extends Error {
  readonly code: SupervisorErrorCode;

  constructor(code: SupervisorErrorCode, message: string) {
    super(message);
    this.name = 'SupervisorError';
    this.code = code;
  }
}
