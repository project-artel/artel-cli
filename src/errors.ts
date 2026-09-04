/**
 * `--json` error envelope 의 `code` 로 나가는 닫힌 집합.
 *
 * 이 집합은 첫 릴리스부터 공개 계약이다. 값을 새로 더하는 것은 breaking 이 아니지만,
 * 있던 값의 뜻을 바꾸는 것은 breaking 이다.
 */
export const ERROR_CODES = [
  'login_timeout',
  'login_state_mismatch',
  'login_denied',
  'login_not_supported',
  'loopback_port',
  'loopback_abuse',
  'no_credential',
  'credential_file_mode',
  'credential_file_unreadable',
  'credential_file_version',
  'missing_api_base_url',
  'missing_console_base_url',
  'invalid_base_url',
  'network_error',
  'server_error',
  'internal_error',
  'sdk_token_not_supported',
  'game_build_not_found',
  'game_launch_failed',
  'game_exited_before_registration',
  'game_registration_timeout',
  'game_logout_timeout',
  'qa_sdk_disconnected',
  'qa_run_active',
  'qa_test_run_empty',
  'qa_run_not_found',
  'qa_run_not_active',
  'qa_watch_disconnected',
  'qa_watch_timeout',
  'qa_invalid_arch',
  'case_not_found',
  'case_invalid_request',
  'case_invalid_body',
  'scenario_not_found',
  'scenario_project_not_found',
  'scenario_has_qa_history',
  'scenario_invalid_steps',
  'scenario_invalid_labels',
  'run_not_found',
  'run_invalid_request',
  'run_has_qa_history',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * 사용자에게 그대로 보여도 되는 실패. `message` 는 stdout 의 error envelope 과
 * 사람용 출력 양쪽에 그대로 실리므로 token 문자열을 담아서는 안 된다.
 */
export class CliError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'CliError';
    this.code = code;
  }
}

/** commander 가 잡아내는 사용법 오류. exit code 2 로 끝난다. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}
