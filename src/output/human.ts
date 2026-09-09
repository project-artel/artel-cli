import type { ContentMapScanEvent } from '../doc/scan-flow.js';
import type { DocumentUploadEvent } from '../doc/upload-flow.js';
import { describeSelector, ratio } from '../qa/diff.js';
import type { QaFollowEvent } from '../qa/follow.js';
import type {
  ContentMapScanPayload,
  DocumentUploadPayload,
  GameLogoutPayload,
  GameStartPayload,
  LoginPayload,
  LogoutPayload,
  QaCancelPayload,
  QaCountsPayload,
  QaDiffPayload,
  QaMatrixCombinationPayload,
  QaMatrixPayload,
  QaMetricsPayload,
  QaRunPayload,
  QaUsagePayload,
  QaVerdictValue,
  ScenarioApprovePayload,
  ScenarioDeletePayload,
  ScenarioListPayload,
  ScenarioPayload,
  StatusPayload,
  TestRunDeletePayload,
  TestRunListPayload,
  TestRunPayload,
  TestRunScenariosPayload,
} from './contract.js';
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
    sink.out(describeCliVersion(payload.cliVersion));
    sink.out(`  credentials file  ${payload.credentialsPath} (missing)`);
    sink.out(describeEnvVar(payload.envVarState));
    sink.out(describeApiBaseUrl(payload));
    sink.out('Run "artel auth login", or set ARTEL_TOKEN.');
    return;
  }

  sink.out(payload.source === 'env' ? 'Signed in with ARTEL_TOKEN.' : 'Signed in.');
  sink.out(describeCliVersion(payload.cliVersion));
  sink.out(`  fingerprint       ${payload.fingerprint ?? '-'}`);
  sink.out(
    `  credentials file  ${payload.credentialsPath} (${payload.credentialsFileExists ? describeMode(payload.mode) : 'missing'})`,
  );
  sink.out(describeEnvVar(payload.envVarState));
  if (payload.source === 'file') {
    sink.out(`  token name        ${payload.tokenName ?? '-'}`);
    sink.out(`  token id          ${payload.tokenId ?? '-'}`);
    sink.out(`  expires at        ${payload.expiresAt ?? 'never'}`);
  }
  sink.out(describeApiBaseUrl(payload));
}

/**
 * 출처까지 적는다. 값만 적으면 환경 변수를 지웠을 때 왜 주소가 달라졌는지 이 출력으로
 * 설명되지 않는다. `--api-url` 은 `auth status` 에 없으므로 `flag` 는 여기 나오지 않는다.
 */
function describeApiBaseUrl(payload: StatusPayload): string {
  if (payload.apiBaseUrl === null) {
    return '  api base url      not set (pass --api-url, set ARTEL_API_BASE_URL, or sign in)';
  }
  const origin =
    payload.apiBaseUrlSource === 'env' ? 'ARTEL_API_BASE_URL' : 'credentials file';
  return `  api base url      ${payload.apiBaseUrl} (from ${origin})`;
}

/**
 * 버전은 서명 여부와 무관하게 적는다. 이 출력을 통째로 붙여 올리는 버그 보고가 어느 build 였는지
 * 말하게 하는 것이 이 줄의 쓰임이고, 로그인하지 못한 것 자체가 그 보고의 내용인 경우가 많다.
 */
function describeCliVersion(version: string | null): string {
  return `  cli version       ${version ?? 'unknown'}`;
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

export function printGameStart(sink: OutputSink, payload: GameStartPayload): void {
  sink.out(`Registered as game instance ${payload.instanceId}.`);
  sink.out(`  project        ${payload.projectId}`);
  sink.out(`  build          ${payload.build}`);
  sink.out(
    `  server         ${payload.serverAddress}${payload.secure ? ' (secure)' : ' (insecure)'}`,
  );
  sink.out(`  frontend       ${payload.frontendUrl}`);
  sink.out(`  log file       ${payload.logFilePath}`);
  sink.out(`  pid            ${payload.pid ?? '-'}`);
  sink.out(
    'The game keeps running after this command exits. Pass the instance id above to the QA commands.',
  );
}

export function printGameLogout(sink: OutputSink, payload: GameLogoutPayload): void {
  sink.out(
    `Launched ${payload.build} with -artel-logout and let it exit (code ${payload.exitCode ?? '-'}).`,
  );
  sink.out(
    "The session lives in the game's own platform secret store, not in a file the CLI controls, so only the game process itself can clear it — that is why this command launches the build briefly instead of deleting anything locally.",
  );
  sink.out(`  project        ${payload.projectId}`);
  sink.out(`  log file       ${payload.logFilePath}`);
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

/** `PASSED`/`FAILED`/`unknown`. 미상을 실패로 적지 않는다. */
export function describeVerdict(verdict: QaVerdictValue): string {
  return verdict ?? 'unknown';
}

function describeCounts(counts: QaCountsPayload): string {
  if (counts.passed === null || counts.total === null) {
    return 'unknown';
  }
  return `${String(counts.passed)}/${String(counts.total)} passed`;
}

/** `watch` 한 줄. 사람용 출력과 `--json` 의 NDJSON 이 같은 사건에서 나온다. */
export function describeFollowEvent(event: QaFollowEvent): string {
  switch (event.kind) {
    case 'run-status':
      return `run is ${event.status}`;
    case 'try-start':
      return `[${String(event.index)}/${String(event.of)}] scenario ${event.testScenarioId} (try ${event.tryId})`;
    case 'step':
      return `  step ${String(event.step)}  ${event.passed ? 'pass' : 'FAIL'}${
        event.caseId === null ? '' : `  case ${event.caseId}`
      }${event.message === null ? '' : `  ${event.message}`}`;
    case 'issue':
      return `  issue  ${event.severity}  ${event.title}`;
    case 'error':
      return `  error  ${event.message}`;
    case 'try-end':
      return `  try ${event.tryId} ended ${event.status} — ${describeVerdict(event.verdict)}`;
    case 'reconnect':
      return `  event stream dropped; reconnecting in ${String(event.delayMs)}ms (attempt ${String(event.attempt)}/${String(event.of)})`;
  }
}

export function printQaRun(sink: OutputSink, payload: QaRunPayload): void {
  sink.out(`QA run ${payload.runId} — ${describeVerdict(payload.verdict)} (${payload.status}).`);
  sink.out(`  test run       ${payload.testRunId}`);
  sink.out(`  game instance  ${payload.gameInstanceId}`);
  sink.out(`  started        ${payload.startedAt}`);
  sink.out(`  completed      ${payload.completedAt ?? '-'}`);
  sink.out(`  steps          ${describeCounts(payload.steps)}`);
  sink.out(`  cases          ${describeCounts(payload.cases)}`);
  sink.out(`  usage          ${describeUsage(payload.usage)}`);

  for (const qaTry of payload.tries) {
    sink.out(
      `  scenario ${qaTry.testScenarioId} (try ${qaTry.tryId})  ${qaTry.status}  ${describeVerdict(qaTry.verdict)}  ${describeCounts(qaTry.steps)}`,
    );
    sink.out(
      `    model ${qaTry.model ?? '-'}  prompt ${qaTry.promptVersion ?? '-'}  reasoning ${qaTry.reasoningEffort ?? '-'}  arch ${qaTry.agentArch ?? '-'}`,
    );
    for (const step of qaTry.stepResults) {
      sink.out(
        `    step ${String(step.step)}  ${step.passed ? 'pass' : 'FAIL'}${
          step.message === null ? '' : `  ${step.message}`
        }`,
      );
    }
  }

  if (payload.issues.length === 0) {
    sink.out('  issues         none');
    return;
  }
  sink.out(`  issues         ${String(payload.issues.length)}`);
  for (const issue of payload.issues) {
    sink.out(`    ${issue.severity}  ${issue.title}  (issue ${issue.issueId}, ${issue.status})`);
  }
}

/**
 * 지출 한 줄.
 *
 * `costUsd` 가 없는 것과 0 인 것을 구별해 적는다. 둘을 같은 `$0.00` 으로 그리면, 단가를 모르는
 * provider 로 돌린 arm 이 공짜였던 것으로 읽힌다. 금액이 몇 건의 호출에 얹혔는지도 함께 적어,
 * 일부만 값이 매겨진 금액을 전체 비용으로 읽지 않게 한다.
 */
function describeUsage(usage: QaUsagePayload | null): string {
  if (usage === null) {
    return 'not read';
  }
  const tokens = `${String(usage.inputTokens)} in / ${String(usage.outputTokens)} out`;
  if (usage.costUsd === null) {
    return `${tokens}, ${String(usage.calls)} call(s), cost unknown (no priced call)`;
  }
  const priced =
    usage.pricedCalls === usage.calls
      ? `${String(usage.calls)} call(s)`
      : `${String(usage.pricedCalls)} of ${String(usage.calls)} call(s) priced`;
  return `${tokens}, ${priced}, $${usage.costUsd.toFixed(4)}`;
}

/**
 * 반복을 켰을 때만 조합별 통과 횟수를 적는다.
 *
 * 세는 것까지가 CLI 의 일이다. 평균도 분산도 내지 않는다 — 몇 번 중 몇 번인지는 분모가 보이는
 * 세기이고, 그 위의 통계는 이 목록을 읽는 쪽이 낸다. `qa diff` 가 비율 대신 합을 다루는 것과
 * 같은 규율이다.
 */
function printRepeatTally(sink: OutputSink, payload: QaMatrixPayload): void {
  const repeated = new Map<number, { passed: number; of: number; axes: string }>();
  for (const combination of payload.combinations) {
    const tally = repeated.get(combination.combination) ?? {
      passed: 0,
      of: 0,
      axes: describeAxes(combination),
    };
    tally.of += 1;
    if (combination.verdict === 'PASSED') {
      tally.passed += 1;
    }
    repeated.set(combination.combination, tally);
  }

  // 반복이 없으면 조합 줄을 그대로 다시 적는 것이 되어 아무것도 더하지 않는다.
  if ([...repeated.values()].every((tally) => tally.of === 1)) {
    return;
  }

  sink.out('  by combination:');
  for (const [combination, tally] of repeated) {
    sink.out(
      `    [${String(combination + 1)}] ${String(tally.passed)}/${String(tally.of)} passed  ${tally.axes}`,
    );
  }
}

/**
 * `qa matrix` 요약. 조합마다 한 줄이고, 축 값을 그대로 적는다 — arm 이름은 짓지 않는다.
 */
export function printQaMatrix(sink: OutputSink, payload: QaMatrixPayload): void {
  sink.out(`QA matrix — ${String(payload.succeeded)}/${String(payload.total)} runs passed.`);
  sink.out(`  project        ${payload.projectId}`);
  sink.out(`  label          ${payload.label ?? '-'}`);
  payload.slots.forEach((build, slot) => {
    sink.out(`  slot ${String(slot)}         ${build}`);
  });

  for (const combination of payload.combinations) {
    sink.out(
      `  [${String(combination.index + 1)}] slot ${String(combination.slot)}  ${describeAxes(combination)}`,
    );
    sink.out(
      `      run ${combination.qaRunId ?? '-'}  ${combination.status}  ${describeVerdict(combination.verdict)}  steps ${describeStepCount(combination)}  ${describeDuration(combination.durationMs)}`,
    );
  }

  printRepeatTally(sink, payload);

  const failures = payload.combinations.filter((combination) => combination.verdict !== 'PASSED');
  if (failures.length === 0) {
    return;
  }
  sink.out(`  ${String(failures.length)} runs did not pass:`);
  for (const combination of failures) {
    sink.out(
      `    [${String(combination.index + 1)}] ${describeAxes(combination)} — ${
        combination.error === null
          ? `verdict ${describeVerdict(combination.verdict)} (${combination.status})`
          : `${combination.error.code}: ${combination.error.message}`
      }`,
    );
  }
}

function describeAxes(combination: QaMatrixCombinationPayload): string {
  return `testRun=${combination.testRunId} arch=${combination.archLabel ?? 'server default'} contentMap=${combination.contentMapMode ?? 'server default'} knowledge=${combination.knowledgeMode ?? 'server default'}`;
}

/** 세지 못한 것과 0 은 다르다. 판정 요약이 없는 조합은 `-` 다. */
function describeStepCount(combination: QaMatrixCombinationPayload): string {
  if (combination.stepsTotal === null || combination.stepsPassed === null) {
    return '-';
  }
  return `${String(combination.stepsPassed)}/${String(combination.stepsTotal)}`;
}

function describeDuration(durationMs: number): string {
  return `${(durationMs / 1_000).toFixed(1)}s`;
}

export function printQaCancel(sink: OutputSink, payload: QaCancelPayload): void {
  sink.out(`Cancelled QA run ${payload.runId}; it is now ${payload.status}.`);
  sink.out(
    'The game instance is free again, so a new run can start on it. Scenarios that never ran have no verdict — they are unknown, not failed.',
  );
}

const TABLE_INDENT = '  ';
const LABEL_WIDTH = 24;
const COLUMN_WIDTH = 16;

export function printQaDiff(sink: OutputSink, payload: QaDiffPayload): void {
  sink.out(
    `QA runs from ${payload.from} to ${payload.to}${
      payload.projectId === null ? ' (all visible projects)' : ` (project ${payload.projectId})`
    }.`,
  );
  sink.out(
    `  base    ${describeSelector(payload.base.selector)} — ${String(payload.base.cells)} cell(s)`,
  );
  sink.out(
    `  target  ${describeSelector(payload.target.selector)} — ${String(payload.target.cells)} cell(s)`,
  );
  sink.out('');
  sink.out(
    `${TABLE_INDENT}${''.padEnd(LABEL_WIDTH)}${'base'.padStart(COLUMN_WIDTH)}${'target'.padStart(COLUMN_WIDTH)}${'difference'.padStart(COLUMN_WIDTH)}`,
  );

  const base = payload.base.metrics;
  const target = payload.target.metrics;
  const difference = payload.difference;
  const countRow = (label: string, pick: (metrics: QaMetricsPayload) => number): void => {
    sink.out(
      `${TABLE_INDENT}${label.padEnd(LABEL_WIDTH)}${String(pick(base)).padStart(COLUMN_WIDTH)}${String(pick(target)).padStart(COLUMN_WIDTH)}${signed(pick(difference)).padStart(COLUMN_WIDTH)}`,
    );
  };

  countRow('runs', (metrics) => metrics.runs);
  countRow('completed', (metrics) => metrics.completed);
  countRow('failed', (metrics) => metrics.failed);
  countRow('cancelled', (metrics) => metrics.cancelled);
  countRow('active', (metrics) => metrics.active);
  countRow('verdict known', (metrics) => metrics.verdictKnown);
  countRow('steps total', (metrics) => metrics.stepsTotal);
  countRow('steps passed', (metrics) => metrics.stepsPassed);
  countRow('cases total', (metrics) => metrics.casesTotal);
  countRow('cases passed', (metrics) => metrics.casesPassed);
  countRow('scored runs', (metrics) => metrics.scoredRuns);
  countRow('correct pass', (metrics) => metrics.correctPass);
  countRow('false alarm', (metrics) => metrics.falseAlarm);
  countRow('miss', (metrics) => metrics.miss);
  countRow('correct fail', (metrics) => metrics.correctFail);
  countRow('unreported', (metrics) => metrics.unreported);
  countRow('llm calls', (metrics) => metrics.llmCalls);
  countRow('input tokens', (metrics) => metrics.inputTokens);
  countRow('output tokens', (metrics) => metrics.outputTokens);

  sink.out(
    `${TABLE_INDENT}${'cost (USD)'.padEnd(LABEL_WIDTH)}${money(base.costUsd).padStart(COLUMN_WIDTH)}${money(target.costUsd).padStart(COLUMN_WIDTH)}${money(difference.costUsd).padStart(COLUMN_WIDTH)}`,
  );
  sink.out(
    `${TABLE_INDENT}${'avg completed ms'.padEnd(LABEL_WIDTH)}${number(base.avgCompletedDurationMs).padStart(COLUMN_WIDTH)}${number(target.avgCompletedDurationMs).padStart(COLUMN_WIDTH)}${number(difference.avgCompletedDurationMs).padStart(COLUMN_WIDTH)}`,
  );

  sink.out('');
  rateRow(
    sink,
    'step pass rate',
    base.stepsPassed,
    base.stepsTotal,
    target.stepsPassed,
    target.stepsTotal,
  );
  rateRow(
    sink,
    'case pass rate',
    base.casesPassed,
    base.casesTotal,
    target.casesPassed,
    target.casesTotal,
  );
  rateRow(sink, 'completion rate', base.completed, base.runs, target.completed, target.runs);
  sink.out(
    'Rates are computed here from the sums above, never averaged across cells — the server sends sums for exactly that reason. The denominator is printed with every rate.',
  );

  if (payload.truncated) {
    sink.out(
      'The server truncated its cell list, so cells with the fewest runs were dropped and either side may be counted low.',
    );
  }
  if (payload.base.cells === 0 || payload.target.cells === 0) {
    sink.out('One side matched no cell at all: no run has been recorded with that configuration.');
  }
}

/** 비율은 언제나 분자와 분모를 함께 적는다. 분모가 0 이면 비율이 없는 것이지 0% 가 아니다. */
function rateRow(
  sink: OutputSink,
  label: string,
  baseNumerator: number,
  baseDenominator: number,
  targetNumerator: number,
  targetDenominator: number,
): void {
  const baseRate = ratio(baseNumerator, baseDenominator);
  const targetRate = ratio(targetNumerator, targetDenominator);
  const delta =
    baseRate === null || targetRate === null
      ? '-'
      : `${signedNumber((targetRate - baseRate) * 100, 1)}pp`;
  sink.out(
    `${TABLE_INDENT}${label.padEnd(LABEL_WIDTH)}${percent(baseRate, baseNumerator, baseDenominator).padStart(COLUMN_WIDTH)}${percent(targetRate, targetNumerator, targetDenominator).padStart(COLUMN_WIDTH)}${delta.padStart(COLUMN_WIDTH)}`,
  );
}

function percent(rate: number | null, numerator: number, denominator: number): string {
  if (rate === null) {
    return `- (0/0)`;
  }
  return `${(rate * 100).toFixed(1)}% (${String(numerator)}/${String(denominator)})`;
}

function signed(value: number): string {
  return value > 0 ? `+${String(value)}` : String(value);
}

function signedNumber(value: number, digits: number): string {
  const text = value.toFixed(digits);
  return value > 0 ? `+${text}` : text;
}

function money(value: number | null): string {
  return value === null ? '-' : value.toFixed(6);
}

function number(value: number | null): string {
  return value === null ? '-' : String(value);
}

export function printScenarioList(sink: OutputSink, payload: ScenarioListPayload): void {
  if (payload.scenarios.length === 0) {
    sink.out(`Project ${payload.projectId} has no test scenarios.`);
    return;
  }
  sink.out(`Project ${payload.projectId} — ${String(payload.scenarios.length)} test scenario(s).`);
  for (const scenario of payload.scenarios) {
    sink.out(
      `  ${scenario.scenarioId}  ${scenario.title.length === 0 ? '(untitled)' : scenario.title}  (updated ${scenario.updatedAt ?? '-'})`,
    );
  }
}

/** `scenario create`·`show`·`update` 가 모두 이 한 모양을 낸다(`qa run`/`watch`/`show` 와 같은 규율). */
export function printScenario(sink: OutputSink, payload: ScenarioPayload): void {
  sink.out(`Test scenario ${payload.scenarioId} (project ${payload.projectId}).`);
  sink.out(`  title        ${payload.title.length === 0 ? '(untitled)' : payload.title}`);
  sink.out(`  description  ${payload.description.length === 0 ? '(none)' : payload.description}`);
  if (payload.steps.length === 0) {
    sink.out('  steps        none');
    return;
  }
  sink.out(`  steps        ${String(payload.steps.length)}`);
  for (const step of payload.steps) {
    sink.out(
      `    ${String(step.step)}. ${step.action}${step.caseId === null ? '' : `  case ${String(step.caseId)}`}${
        step.hint === null ? '' : `  hint: ${step.hint}`
      }${step.input === null ? '' : `  input: ${step.input}`}  expected: ${describeExpectedPassed(step.expectedPassed)}`,
    );
  }
}

function describeExpectedPassed(value: boolean | null): string {
  if (value === null) {
    return 'unscored';
  }
  return value ? 'pass' : 'fail';
}

export function printScenarioApprove(sink: OutputSink, payload: ScenarioApprovePayload): void {
  sink.out(`Approved test scenario ${payload.scenarioId}.`);
  sink.out(
    'The server does not track approval as a gate: it keeps no "approved" field, and an unapproved scenario can already be added to a test run and executed. Approval here is a final save, not a permission check.',
  );
}

export function printScenarioDelete(sink: OutputSink, payload: ScenarioDeletePayload): void {
  sink.out(
    payload.forced
      ? `Deleted test scenario ${payload.scenarioId}, along with its QA run history.`
      : `Deleted test scenario ${payload.scenarioId}.`,
  );
}

export function printTestRun(sink: OutputSink, payload: TestRunPayload): void {
  sink.out(`Test run ${payload.runId} — ${payload.name}.`);
  sink.out(`  project        ${payload.projectId}`);
  sink.out(`  description    ${payload.description ?? '-'}`);
  sink.out(`  created        ${payload.createdAt}`);
}

export function printTestRunList(sink: OutputSink, payload: TestRunListPayload): void {
  if (payload.items.length === 0) {
    sink.out('No test runs.');
    return;
  }
  sink.out(`${String(payload.items.length)} test run(s).`);
  for (const run of payload.items) {
    sink.out(
      `  ${run.runId}  ${run.name}${run.description === null ? '' : `  — ${run.description}`}`,
    );
  }
}

export function printTestRunScenarios(sink: OutputSink, payload: TestRunScenariosPayload): void {
  if (payload.items.length === 0) {
    sink.out(`Test run ${payload.runId} has no scenarios bound to it.`);
    return;
  }
  sink.out(
    `Test run ${payload.runId} — ${String(payload.items.length)} scenario(s), in run order.`,
  );
  for (const item of payload.items) {
    sink.out(`  ${String(item.position)}  ${item.testScenarioId}`);
  }
}

export function printTestRunDelete(sink: OutputSink, payload: TestRunDeletePayload): void {
  const preview = payload.preview;
  if (!payload.confirmed) {
    sink.out(`Not deleted. Test run ${payload.runId} would take the following down with it:`);
    sink.out(`  scenarios in this run           ${String(preview.scenarioCount)}`);
    sink.out(
      `  scenarios only in this run      ${String(preview.removableScenarioCount)}${payload.dropScenarios ? ' (would be deleted with --drop-scenarios)' : ' (kept unless you pass --drop-scenarios)'}`,
    );
    sink.out(`  of those, kept for QA history   ${String(preview.keptForQaHistoryCount)}`);
    sink.out('Re-run with --yes to confirm the delete.');
    return;
  }

  sink.out(`Deleted test run ${payload.runId}.`);
  if (payload.dropScenarios) {
    sink.out(`  scenarios deleted with it       ${String(payload.deletedScenarioCount ?? 0)}`);
    sink.out(
      `  kept for QA history             ${String(payload.deletedKeptForQaHistoryCount ?? 0)}`,
    );
  } else {
    sink.out(
      '  its scenarios were left in place (pass --drop-scenarios to remove the ones only it used)',
    );
  }
}

/** `doc upload` 한 줄. 진행 사건은 stderr 로 가고 이 요약은 stdout 으로 간다. */
export function describeDocumentUploadEvent(event: DocumentUploadEvent): string {
  switch (event.kind) {
    case 'ticket':
      return `upload url issued for ${event.objectKey} (expires ${event.expiresAt})`;
    case 'uploaded':
      return `uploaded ${String(event.sizeBytes)} bytes`;
    case 'registered':
      return `registered as document ${event.documentId} version ${String(event.version)} (${event.parseStatus})`;
    case 'parse-status':
      return `  parse status ${event.parseStatus}${event.stale ? ' (stale: the server is not holding this extraction)' : ''}`;
    case 'reconnect':
      return `  event stream dropped; reconnecting in ${String(event.delayMs)}ms (attempt ${String(event.attempt)}/${String(event.of)})`;
  }
}

export function printDocumentUpload(sink: OutputSink, payload: DocumentUploadPayload): void {
  sink.out(
    `Uploaded ${payload.fileName} to project ${payload.projectId} as document ${payload.documentId}.`,
  );
  sink.out(`  version        ${String(payload.version)}`);
  sink.out(`  size           ${String(payload.sizeBytes)} bytes`);
  sink.out(`  uploaded at    ${payload.uploadedAt}`);
  sink.out(`  parse status   ${payload.parseStatus}${describeStale(payload.stale)}`);

  if (payload.watched) {
    sink.out(describeParseOutcome(payload));
    return;
  }
  sink.out(
    'Extraction runs on the server after this command exits, so the status above is the one at registration time. Pass --watch to follow it to EXTRACTED or FAILED.',
  );
}

function describeStale(stale: boolean | null): string {
  if (stale === null) {
    return '';
  }
  return stale ? '  (stale)' : '';
}

function describeParseOutcome(payload: DocumentUploadPayload): string {
  if (payload.stale === true) {
    return 'The server restarted while this document was being extracted, so the row is stuck at EXTRACTING and will not move on its own. Delete this version and upload it again.';
  }
  if (payload.parseStatus === 'EXTRACTED') {
    return 'The document was read and its `knowledge` items are stored.';
  }
  return 'The extraction failed. The document version stays, but no `knowledge` came out of it.';
}

/** `doc scan` 한 줄. */
export function describeContentMapScanEvent(event: ContentMapScanEvent): string {
  switch (event.kind) {
    case 'requested':
      return `scan requested on game instance ${event.gameInstanceName} (${event.gameInstanceId}) at ${event.requestedAt}`;
    case 'scan-state':
      return `  scan is ${event.state}${event.error === null ? '' : ` — ${event.error}`}`;
    case 'ingest':
      return `  documents ${String(event.progress.ingestedDocuments)} ingested, ${String(event.progress.failedDocuments)} failed, of ${String(event.progress.receivedDocuments)} received`;
    case 'reconnect':
      return `  event stream dropped; reconnecting in ${String(event.delayMs)}ms (attempt ${String(event.attempt)}/${String(event.of)})`;
  }
}

export function printContentMapScan(sink: OutputSink, payload: ContentMapScanPayload): void {
  sink.out(
    `Told game instance ${payload.gameInstanceName} (${payload.gameInstanceId}) to scan game build ${payload.gameBuildId}.`,
  );
  sink.out(`  project        ${payload.projectId}`);
  sink.out(`  state          ${payload.state}`);
  sink.out(`  requested at   ${payload.requestedAt}`);
  sink.out(`  finished at    ${payload.finishedAt ?? '-'}`);
  sink.out(
    `  documents      ${payload.ingestedDocuments === null ? '-' : String(payload.ingestedDocuments)} ingested`,
  );
  if (payload.error !== null) {
    sink.out(`  error          ${payload.error}`);
  }

  if (!payload.watched) {
    sink.out(
      'The command was sent, not finished: a scan walks the scenes inside the running game. Pass --watch to follow it, or read the content map later.',
    );
    return;
  }
  if (payload.state === 'SUCCEEDED' && payload.ingestedDocuments === 0) {
    sink.out(
      'The scan ran but no `evidence` document arrived, so nothing was ingested. The game finished the walk without uploading anything.',
    );
  }
}
