import type { ErrorCode } from '../errors.js';
import type {
  CaseCreateBatchPayload,
  CaseDeletePayload,
  CaseListPayload,
  ErrorEnvelope,
  GameLogoutPayload,
  GameStartPayload,
  LoginPayload,
  LogoutPayload,
  QaCancelPayload,
  QaDiffPayload,
  QaRunPayload,
  StatusPayload,
  TestCaseDetailPayload,
  TestCasePayload,
} from './contract.js';

export type CommandPayload =
  | LoginPayload
  | StatusPayload
  | LogoutPayload
  | GameStartPayload
  | GameLogoutPayload
  | QaRunPayload
  | QaCancelPayload
  | QaDiffPayload
  | TestCasePayload
  | TestCaseDetailPayload
  | CaseListPayload
  | CaseCreateBatchPayload
  | CaseDeletePayload;

/**
 * 출력 두 갈래를 한 곳으로 모은다. 테스트가 실제 stdout 을 건드리지 않고 무엇이 찍혔는지
 * 통째로 보게 하는 지점이기도 하다.
 */
export interface OutputSink {
  out(line: string): void;
  err(line: string): void;
}

export const processSink: OutputSink = {
  out(line) {
    process.stdout.write(`${line}\n`);
  },
  err(line) {
    process.stderr.write(`${line}\n`);
  },
};

/** 성공 payload 는 stdout 에 한 줄. */
export function writeJsonPayload(sink: OutputSink, payload: CommandPayload): void {
  sink.out(JSON.stringify(payload));
}

/**
 * 실패해도 envelope 은 stderr 가 아니라 stdout 에 낸다. `--json` 을 켠 쪽은 stdout 하나만
 * 읽으면 성공이든 실패든 같은 자리에서 JSON 을 얻는다.
 */
export function writeErrorEnvelope(sink: OutputSink, code: ErrorCode, message: string): void {
  const envelope: ErrorEnvelope = { error: { code, message } };
  sink.out(JSON.stringify(envelope));
}
