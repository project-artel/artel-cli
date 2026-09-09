import type { ApiBaseUrlSource } from '../config.js';
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
  /** 이 CLI 의 버전. `package.json` 을 읽지 못했으면 `null` 이다. */
  cliVersion: string | null;
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
  /**
   * 명령이 실제로 부를 주소. `ARTEL_API_BASE_URL` 이 있으면 그것이고, 없으면 자격증명 파일에
   * 적힌 값이다. 둘 다 없으면 `null` 이다.
   *
   * 파일에 적힌 값만 내던 자리였다. 환경 변수가 이기는 상황에서 그대로 두면 status 가 말한
   * 주소와 명령이 부르는 주소가 달라진다.
   */
  apiBaseUrl: string | null;
  /** 위 값이 어디서 왔는지. `--api-url` 은 `auth status` 에 없으므로 `flag` 는 나오지 않는다. */
  apiBaseUrlSource: ApiBaseUrlSource | null;
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
  /** 이 try 의 지출. 읽지 못했으면 `null` 이다. */
  usage: QaUsagePayload | null;
}

/**
 * 런 하나 또는 try 하나가 쓴 LLM 지출. 필드 이름은 서버의 `LlmUsageTotals` 그대로다.
 *
 * 전부 합계다. `costUsd` 가 `null` 이면 단가를 아는 호출이 하나도 없다는 뜻이고 0 과 다르다 —
 * 둘을 같은 0 으로 읽으면 arm 비용 비교가 조용히 틀린다. `pricedCalls` 가 `calls` 보다 작으면
 * 그 금액은 일부 호출에만 얹힌 값이다.
 *
 * `cachedInputTokens` 는 `inputTokens` 에 포함된 값이라 더하면 두 번 센다.
 *
 * payload 자체가 `null` 이면 사용량을 읽지 못했다는 뜻이다. 지출이 0 이었다는 뜻이 아니다.
 */
export interface QaUsagePayload {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  costUsd: number | null;
  calls: number;
  pricedCalls: number;
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
  /** try 들의 합. 하나도 읽지 못했으면 `null` 이다. */
  usage: QaUsagePayload | null;
}

export interface QaCancelPayload {
  runId: string;
  cancelled: true;
  status: string;
}

/**
 * `qa matrix` 가 돌린 조합 하나.
 *
 * 축 값을 그대로 적는다. `map-only` 같은 arm 이름을 CLI 가 지어내면 그것이 두 번째 진실
 * 원본이 되고, 서버의 `run_config` 와 언젠가 어긋난다. 조합이 무엇인지는 [testRunId] 와
 * 모드 두 개가 말한다.
 *
 * `null` 은 축의 flag 를 주지 않아 서버 기본값으로 돌았다는 뜻이다. 무엇으로 돌았는지를
 * 정확히 알아야 하면 [qaRunId] 로 `qa show` 를 걸어 `run_config` 를 읽으면 된다.
 */
export interface QaMatrixCombinationPayload {
  /** 전개 순서. 0부터. 같은 명령은 같은 조합에 같은 번호를 준다. */
  index: number;
  /**
   * 축 값이 같은 반복들이 공유하는 번호. `--repeat` 이 1 이면 [index] 와 같다.
   *
   * 이 둘을 나눠 싣는 이유는 반복이 통계의 재료이기 때문이다. `combination` 으로 묶고
   * `repeat` 으로 세면 조합마다 몇 번 중 몇 번 통과했는지가 나오는데, 하나로 뭉개면 그 계산이
   * 불가능해진다. CLI 는 그 계산을 하지 않고 재료만 낸다.
   */
  combination: number;
  /** 그 조합의 몇 번째 반복인지. 0부터. */
  repeat: number;
  /** 이 조합이 돈 슬롯. 0부터, `--slot` 을 적은 순서다. */
  slot: number;
  /** 그 슬롯의 빌드 경로. 슬롯마다 빌드가 다르다. */
  build: string;
  testRunId: string;
  /** 축 값 그대로. `null` 은 그 축의 flag 를 주지 않아 서버 기본값으로 돌았다는 뜻이다. */
  model: string | null;
  promptVersion: string | null;
  reasoningEffort: string | null;
  /**
   * arch 축 값의 `label`. arch object 전체가 아니라 이 이름만 싣는다 — 조합의 정체가 이
   * label 하나이고([describeCombination] 이 arm 이름을 짓지 않는 이유와 같다), `null` 은
   * 그 축의 flag 를 주지 않아 서버 기본값으로 돌았다는 뜻이다.
   */
  archLabel: string | null;
  contentMapMode: string | null;
  knowledgeMode: string | null;
  gameInstanceId: string | null;
  qaRunId: string | null;
  /**
   * 런 생명주기 상태. 런이 시작되지도 못한 조합은 `NOT_STARTED` 다 — 서버가 준 값이 아니라
   * 이 CLI 가 "런이 없다" 를 적는 자리다.
   */
  status: string;
  verdict: QaVerdictValue;
  stepsPassed: number | null;
  stepsTotal: number | null;
  /**
   * 이 조합이 쓴 지출. arm 을 비교할 때 "어느 쪽이 더 맞혔나" 만으로는 결론이 서지 않는다 —
   * 정확도를 조금 올리면서 token 을 두 배 쓴 arm 은 다른 결론이다.
   */
  usage: QaUsagePayload | null;
  /** 게임을 띄우기 시작해 런이 끝날 때까지. 띄우는 시간이 들어 있다. */
  durationMs: number;
  /** 실패한 이유. 통과했거나 판정만 `FAILED` 인 조합은 `null` 이다. */
  error: { code: ErrorCode; message: string } | null;
}

/**
 * `qa matrix` 한 번의 결과 전부.
 *
 * [succeeded] 는 판정이 `PASSED` 인 조합의 수다. `qa run` 이 판정을 exit code 로 내는 것과
 * 같은 규칙이라, 판정이 `FAILED` 이거나 미상인 조합도 실패로 센다.
 */
export interface QaMatrixPayload {
  /** `--label`. 실험 묶음의 이름이고 arm 이름이 아니다. */
  label: string | null;
  projectId: string;
  /** 슬롯의 빌드 경로. 첨자가 슬롯 번호다. */
  slots: string[];
  total: number;
  succeeded: number;
  failed: number;
  /** 전개 순서대로. 슬롯이 병렬로 돌아도 이 배열의 순서는 실행 시간에 흔들리지 않는다. */
  combinations: QaMatrixCombinationPayload[];
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
/**
 * `project list --json`. 서버가 페이지로 답하므로 `page`·`size`·`total` 을 그대로 싣는다 —
 * `items` 만 내면 받은 것이 전부인지 잘린 것인지 읽는 쪽이 알 수 없다.
 */
/**
 * `qa list --json`.
 *
 * `fetched` 와 `limit` 을 함께 싣는 이유는 `--status` 가 서버가 아니라 CLI 에서 걸리기
 * 때문이다. `items.length` 만 내면 그것이 프로젝트 전체에서 나온 수인지 최근 몇 개에서 나온
 * 수인지 읽는 쪽이 알 수 없다.
 */
/** `qa models --json`. */
export interface QaModelsPayload {
  items: QaModelPayload[];
}

export interface QaModelPayload {
  /** `--model` 에 그대로 넣는 값. */
  id: string;
  label: string;
  provider: string;
  multimodal: boolean;
  /** 능력 서술을 읽지 못했으면 `null` 이다. 그것은 reasoning 이 없다는 뜻과 다르다. */
  reasoningKind: string | null;
  /** `--reasoning-effort` 에 넣을 수 있는 값. model 마다 다르다. */
  reasoningEfforts: string[] | null;
}

/** `qa labels --json`. `projectId` 가 `null` 이면 볼 수 있는 전 프로젝트의 목록이다. */
export interface QaLabelsPayload {
  labels: string[];
  projectId: string | null;
}

/**
 * `issue list --json`. 최신순 커서 페이지다.
 *
 * `nextBeforeId` 와 `hasMore` 를 그대로 싣는다. 커서를 감추면 받은 것이 전부인지 잘린 것인지
 * 읽는 쪽이 알 수 없고, 없는 이슈를 없다고 읽는다.
 */
/**
 * `map show --json`. 지도 전체가 아니라 세는 값들이다 — 씬과 기능 원문은 콘솔이 그린다.
 *
 * `contentMapId` 가 `null` 인 것과 `ingestedAt` 이 `null` 인 것은 다른 상태다. 앞은 등록된
 * `evidence` 문서가 없는 것이고, 뒤는 등록은 됐는데 아직 앉지 않은 것이다.
 *
 * `lastScanState` 가 `null` 이면 서버가 뜬 뒤로 이 빌드에 스캔을 시킨 적이 없다는 뜻이지,
 * 지도가 스캔 없이 생겼다는 뜻이 아니다.
 */
export interface ContentMapViewPayload {
  projectId: string;
  gameBuildId: string;
  contentMapId: string | null;
  ingestedAt: string | null;
  scenes: number;
  edges: number;
  screenTransitions: number;
  gaps: number;
  pendingDocuments: number;
  verifiedFeatures: number;
  totalFeatures: number;
  lastScanState: string | null;
  lastScanFinishedAt: string | null;
  lastScanError: string | null;
}

export interface IssueListPayload {
  items: IssuePayload[];
  nextBeforeId: string | null;
  hasMore: boolean;
}

export interface IssuePayload {
  id: string;
  /** 이 이슈를 찾은 try. */
  qaTryId: string;
  /** 그 try 가 속한 run. `qa show` 가 받는 값이다. */
  qaRunId: string | null;
  severity: string;
  title: string;
  status: string;
  reportedAt: string;
  resolvedAt: string | null;
}

/**
 * `issue resolve --json` 과 `issue reopen --json`.
 *
 * 서버가 본문 없는 204 를 내므로 이것은 되읽은 값이 아니라 CLI 가 아는 사실이다 — 어느 이슈에
 * 어느 명령을 걸었고 그것이 성공했다는 것. 실제 상태를 다시 확인하려면 `issue list` 를 부른다.
 */
export interface IssueStatusChangePayload {
  issueId: string;
  action: 'resolve' | 'reopen';
  status: string;
}

export interface QaListPayload {
  items: QaTrySummaryPayload[];
  /** 서버에서 받은 개수. `--status` 를 걸기 전의 수다. */
  fetched: number;
  /** 서버에 보낸 `size`. */
  limit: number;
  statusFilter: string | null;
}

export interface QaTrySummaryPayload {
  id: string;
  /** 이 try 가 속한 run. `qa show`·`qa watch`·`qa cancel` 이 받는 것이 이 값이다. */
  qaRunId: string | null;
  testScenarioId: string;
  gameInstanceId: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  model: string | null;
  promptVersion: string | null;
  reasoningEffort: string | null;
  agentArch: string | null;
}

export interface ProjectListPayload {
  items: ProjectPayload[];
  page: number;
  size: number;
  total: number;
}

export interface ProjectPayload {
  id: string;
  name: string;
  genre: string;
  description: string | null;
  /** 이 프로젝트에서 부르는 사람의 역할. */
  myRole: string;
  updatedAt: string;
}

/**
 * `game list --json`. 이 endpoint 는 페이지를 나누지 않으므로 봉투에 개수만 담는다.
 */
export interface GameInstanceListPayload {
  items: GameInstancePayload[];
}

export interface GameInstancePayload {
  id: string;
  projectId: string;
  name: string;
  platform: string;
  /** 지금 SDK 가 붙어 있는지. `qa run --instance` 는 붙어 있는 것에만 걸린다. */
  connected: boolean;
  lastConnectedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

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

/**
 * 시나리오 스텝 하나. Agent 계약(`QaStep`, artel-agent-server `app/qa/schemas.py`)이 읽는
 * 필드만 CLI 가 다룬다 — `action`·`caseId`·`hint`·`input`. 저작 챗봇 전용 필드(근거 종류,
 * GAP/OPENING 구분 등)는 이 CLI 가 쓰지도 보여주지도 않는다.
 */
export interface ScenarioStepPayload {
  /** 1부터 시작하는 위치. `artel scenario expected-labels` 가 스텝을 짚는 번호와 같다. */
  step: number;
  action: string;
  caseId: number | null;
  hint: string | null;
  input: string | null;
  /**
   * 이 스텝이 통과해야 하는지에 대한 사람의 판단(정답지). `null` 은 "채점하지 않음"이지
   * "통과해야 함"이 아니다. `artel scenario approve` 로는 바뀌지 않는다 — 유일한 경로는
   * `artel scenario expected-labels` 다.
   */
  expectedPassed: boolean | null;
}

export interface ScenarioPayload {
  scenarioId: string;
  projectId: string;
  title: string;
  description: string;
  steps: ScenarioStepPayload[];
}

export interface ScenarioSummaryPayload {
  scenarioId: string;
  projectId: string;
  title: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ScenarioListPayload {
  projectId: string;
  scenarios: ScenarioSummaryPayload[];
}

/**
 * 서버는 승인 상태를 저장하지 않는다 — `approve` 는 마지막 draft 를 확정 저장할 뿐이고,
 * 승인 여부를 되읽을 수 있는 필드가 시나리오 어디에도 없다. 그래서 `approved` 는 언제나
 * `true` 다: 이 호출이 성공했다는 사실 이상은 서버가 기억하지 않는다.
 */
export interface ScenarioApprovePayload {
  scenarioId: string;
  approved: true;
}

export interface ScenarioDeletePayload {
  scenarioId: string;
  deleted: true;
  forced: boolean;
}

/**
 * test run 하나. `qa run` 이 실행하는 시나리오 묶음(자료)이지, 실행 자체(`QaRunPayload`)가
 * 아니다 — 이름이 가깝지만 이 둘은 서로 다른 것을 가리킨다.
 */
export interface TestRunPayload {
  runId: string;
  projectId: string;
  name: string;
  description: string | null;
  createdAt: string;
}

export interface TestRunListPayload {
  items: TestRunPayload[];
}

/** [position] 이 실행 순서다. 벤치마크의 첫 시나리오는 저장 없이 새로 설치한 상태를 가정하므로 0번이어야 한다. */
export interface TestRunScenarioItemPayload {
  position: number;
  testScenarioId: string;
}

/** `run scenarios` 의 조회와 교체(`--set`)가 같은 모양을 낸다. */
export interface TestRunScenariosPayload {
  runId: string;
  items: TestRunScenarioItemPayload[];
}

/** 지우기 전에 무엇이 같이 없어지는지 미리 센 값. `run delete` 가 실제로 지우기 전에 항상 이것부터 보여준다. */
export interface TestRunDeletionPreviewPayload {
  scenarioCount: number;
  removableScenarioCount: number;
  keptForQaHistoryCount: number;
}

/**
 * `run delete` 한 번의 전체 결과.
 *
 * [confirmed] 가 `false` 면 `--yes` 없이 불러 미리보기만 하고 실제로는 지우지 않은 것이다 —
 * 그때 [deletedScenarioCount]·[deletedKeptForQaHistoryCount] 는 `null` 이다(시도하지 않았다는
 * 뜻이지 0건이라는 뜻이 아니다). [preview] 는 두 경우 모두 항상 채워진다.
 */
export interface TestRunDeletePayload {
  runId: string;
  dropScenarios: boolean;
  confirmed: boolean;
  preview: TestRunDeletionPreviewPayload;
  deletedScenarioCount: number | null;
  deletedKeptForQaHistoryCount: number | null;
}

/**
 * `doc upload` 한 번의 결과.
 *
 * [parseStatus] 는 `PENDING` · `EXTRACTING` · `EXTRACTED` · `FAILED` 중 하나다. 등록은
 * 추출을 기다리지 않으므로 `--watch` 없이 부르면 여기에 거의 언제나 `PENDING` 이 온다 —
 * 그것은 실패가 아니라 "서버가 이제 시작한다" 이다.
 *
 * [stale] 이 `null` 인 것은 `--watch` 를 주지 않아 확인하지 않았다는 뜻이다. `true` 는
 * `parseStatus` 가 `EXTRACTING` 인데 서버가 그 추출을 들고 있지 않다는 뜻이라, 기다려도
 * 움직이지 않는다.
 */
export interface DocumentUploadPayload {
  projectId: string;
  documentId: string;
  version: number;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: string;
  parseStatus: string;
  stale: boolean | null;
  watched: boolean;
}

/**
 * `doc scan` 한 번의 결과.
 *
 * [state] 는 `REQUESTED` · `SUCCEEDED` · `FAILED` 중 하나다. `--watch` 없이 부르면 언제나
 * `REQUESTED` 다 — 명령이 나갔다는 뜻이고 스캔이 끝났다는 뜻이 아니다.
 *
 * [finishedAt] · [ingestedDocuments] · [error] 는 스캔이 끝나야 값이 생기므로 `REQUESTED`
 * 에서는 셋 다 `null` 이다. [ingestedDocuments] 가 `0` 인데 [state] 가 `SUCCEEDED` 면
 * 스캔은 돌았는데 올라온 문서가 없었다는 뜻이다.
 */
export interface ContentMapScanPayload {
  projectId: string;
  gameBuildId: string;
  gameInstanceId: string;
  gameInstanceName: string;
  state: string;
  requestedAt: string;
  finishedAt: string | null;
  ingestedDocuments: number | null;
  error: string | null;
  watched: boolean;
}
