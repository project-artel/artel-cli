import type { ErrorCode } from '../errors.js';

/**
 * `--json` 출력의 모양. 첫 릴리스부터 공개 계약이다.
 *
 * 키는 사라지지 않는다 — 모르는 값은 `null` 이다. 키를 지우거나 이름을 바꾸는 것이
 * breaking change 다. 어느 payload 에도 `token` 필드는 없다: `--json` 출력은 CI 로그로
 * 곧장 흘러 들어가고, token 이 필요한 프로그램은 `credentialsPath` 를 읽으면 된다.
 */

export interface LoginPayload {
  authenticated: boolean;
  source: 'file';
  credentialsPath: string;
  mode: string | null;
  fingerprint: string;
  tokenId: string;
  tokenName: string;
  createdAt: string;
  expiresAt: string | null;
  apiBaseUrl: string;
}

export interface StatusPayload {
  authenticated: boolean;
  source: 'env' | 'file' | null;
  envVarState: 'used' | 'empty' | 'unset';
  credentialsPath: string;
  credentialsFileExists: boolean;
  mode: string | null;
  fingerprint: string | null;
  tokenId: string | null;
  tokenName: string | null;
  expiresAt: string | null;
  apiBaseUrl: string | null;
}

export interface LogoutPayload {
  removed: boolean;
  credentialsPath: string;
  tokenId: string | null;
  /**
   * 언제나 `false`. 이 CLI 의 `logout` 은 로컬 파일만 지운다. 계정을 바꾸려고 logout 한
   * 사람의 다른 머신 token 까지 죽이는 것은 놀라운 동작이라 서버에 `DELETE` 를 보내지
   * 않는다. 이 필드가 그 사실을 기계가 읽을 수 있게 적은 것이다.
   */
  serverSideRevoked: false;
}

export interface GameStartPayload {
  launched: true;
  build: string;
  projectId: string;
  /** QA 명령들이 대상을 짚는 데 쓰는 값. */
  instanceId: string;
  registeredAt: string | null;
  serverAddress: string;
  secure: boolean;
  frontendUrl: string;
  logFilePath: string;
  pid: number | null;
}

export interface GameLogoutPayload {
  build: string;
  projectId: string;
  serverAddress: string;
  secure: boolean;
  frontendUrl: string;
  logFilePath: string;
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
}

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
  };
}

/**
 * QA 판정. `null` 은 모른다는 뜻이고, 실패가 아니다. 소켓이 죽거나 취소되어 종단 요약을
 * 싣지 못한 런이 여기 들어온다.
 */
export type QaVerdictValue = 'PASSED' | 'FAILED' | null;

/** 아는 값만 채운다. `0` 과 `null` 은 다르다 — 뒤쪽은 세지 못한 것이다. */
export interface QaCountsPayload {
  total: number | null;
  passed: number | null;
  failed: number | null;
}

export interface QaStepPayload {
  step: number;
  passed: boolean;
  caseId: string | null;
  isVerification: boolean;
  message: string | null;
}

export interface QaIssuePayload {
  issueId: string;
  tryId: string;
  severity: string;
  title: string;
  status: string;
  reportedAt: string;
}

/**
 * 시나리오 하나의 실행.
 *
 * [status] 는 런 생명주기(`PENDING`/`RUNNING`/`COMPLETED`/`FAILED`/`CANCELLED`)이고
 * [verdict] 는 QA 판정이다. 서버가 둘을 갈라 두었으므로 여기서도 가른다 — `COMPLETED` 는
 * 끝까지 돌았다는 뜻이지 통과했다는 뜻이 아니다.
 *
 * 네 축(`model`·`promptVersion`·`reasoningEffort`·`agentArch`)은 `qa diff` 가 셀을 고르는
 * 축과 같은 값이다. 그래야 하나의 런을 보고 그 설정으로 곧장 diff 를 걸 수 있다.
 */
export interface QaTryPayload {
  tryId: string;
  testScenarioId: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  model: string | null;
  promptVersion: string | null;
  reasoningEffort: string | null;
  agentArch: string | null;
  agentFingerprint: string | null;
  verdict: QaVerdictValue;
  steps: QaCountsPayload;
  cases: QaCountsPayload;
  stepResults: QaStepPayload[];
}

/** `qa run`, `qa watch`, `qa show` 가 모두 이 한 모양을 낸다. */
export interface QaRunPayload {
  runId: string;
  testRunId: string;
  gameInstanceId: string;
  status: string;
  verdict: QaVerdictValue;
  startedAt: string;
  completedAt: string | null;
  steps: QaCountsPayload;
  cases: QaCountsPayload;
  tries: QaTryPayload[];
  issues: QaIssuePayload[];
}

export interface QaCancelPayload {
  runId: string;
  cancelled: true;
  status: string;
}

/**
 * `/api/qa-stats` 셀 한 줄의 숫자 부분. 전부 **합계**이고 비율은 하나도 없다.
 *
 * `QaStatsDtos.kt` 가 평균 대신 합계를 내보내는 이유를 그대로 지킨다: 비율만 남기면 그것이
 * 몇 개의 런에 얹힌 값인지가 사라지고, 잘 죽는 축일수록 그 비율이 위로 편향된다. 그래서
 * `qa diff --json` 은 화면에 그린 표가 아니라 이 합계와 그 차이를 낸다. 비율이 필요한 쪽은
 * 여기 있는 분자와 분모로 자기가 낸다.
 *
 * [avgCompletedDurationMs] 만 합계가 아니다 — 완주 런의 평균이라 셀을 합칠 때 `completed`
 * 로 가중한 평균을 내고, 차이는 두 평균의 차다.
 */
export interface QaMetricsPayload {
  runs: number;
  completed: number;
  failed: number;
  cancelled: number;
  active: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  costUsd: number | null;
  llmCalls: number;
  avgCompletedDurationMs: number | null;
  verdictKnown: number;
  stepsTotal: number;
  stepsPassed: number;
  casesTotal: number;
  casesPassed: number;
  scoredRuns: number;
  correctPass: number;
  falseAlarm: number;
  miss: number;
  correctFail: number;
  unreported: number;
}

/** 축 값이 `null` 이면 그 축은 고르지 않았다는 뜻이고, 그 축의 모든 값이 함께 합쳐진다. */
export interface QaDiffSelectorPayload {
  model: string | null;
  reasoningEffort: string | null;
  promptVersion: string | null;
  agentArch: string | null;
}

export interface QaDiffSidePayload {
  selector: QaDiffSelectorPayload;
  /** 이 선택에 걸린 `/api/qa-stats` 셀 수. `0` 이면 그 설정으로 돈 런이 없다. */
  cells: number;
  metrics: QaMetricsPayload;
}

export interface QaDiffPayload {
  projectId: string | null;
  from: string;
  to: string;
  /** 서버가 셀을 잘랐다. 잘린 셀은 런 수 하위이므로, 참이면 어느 쪽 합계든 낮게 잡혔을 수 있다. */
  truncated: boolean;
  base: QaDiffSidePayload;
  target: QaDiffSidePayload;
  /** `target - base`. 어느 한쪽이 `null` 인 칸은 `null` 이다. */
  difference: QaMetricsPayload;
}

/**
 * `TestCaseResponse`(orchestration `testcase/dto/TestCaseDtos.kt`)와 같은 필드, 같은 이름.
 * `case list`·`case create`(단건)·`case update` 가 이 모양 그대로 낸다 — 서버가 낸 값을
 * CLI 가 다시 이름 짓지 않는다.
 */
export interface TestCasePayload {
  id: string;
  projectId: string;
  scene: string;
  step: string;
  precondition: string | null;
  expectedValue: string;
  status: string | null;
  verificationStatus: string;
  lastVerifiedBuildId: string | null;
  createdAt: string;
}

/** `TestCaseDetailResponse`. [TestCasePayload] 에 `evidenceGaps` 하나만 더 붙는다. `case show` 전용. */
export interface TestCaseDetailPayload extends TestCasePayload {
  evidenceGaps: string[];
}

/** `case list --json`. `TestCaseListResponse` 와 같은 모양이다. */
export interface CaseListPayload {
  items: TestCasePayload[];
}

/**
 * `case create --json` 가 JSON body 로 배열을 받았을 때, 항목 하나의 결과.
 *
 * `created`/`error` 는 정확히 하나만 채워진다 — 성공하면 만들어진 케이스, 실패하면 그
 * 항목만의 오류다. 한 항목의 실패가 나머지 항목을 막지 않는다([CaseCreateBatchPayload] 참조).
 */
export interface CaseCreateResultPayload {
  /** 입력 배열에서의 0-based 위치. */
  index: number;
  created: TestCasePayload | null;
  error: { code: ErrorCode; message: string } | null;
}

/**
 * `case create --json` 가 배열을 받아 여럿을 만들려 했을 때. 서버에 일괄 생성 endpoint 가
 * 없으므로 CLI 가 항목마다 따로 요청하고, **끝까지 계속한다** — 항목 하나가 400 으로
 * 막혀도 나머지가 만들어질 기회를 잃지 않는다. `created`/`failed` 로 결과를 한눈에 보고,
 * 실패한 항목은 [CaseCreateResultPayload.error] 에서 이유를 본다.
 */
export interface CaseCreateBatchPayload {
  projectId: string;
  requested: number;
  created: number;
  failed: number;
  results: CaseCreateResultPayload[];
}

/** `case delete --json`. 서버는 204 로 몸통 없이 답하므로, 지운 사실은 CLI 가 이 모양으로 만든다. */
export interface CaseDeletePayload {
  id: string;
  projectId: string;
  deleted: true;
}
