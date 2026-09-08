import { CliError } from '../errors.js';
import type { FetchLike } from './client.js';
import { parseHttpFailure, toCliError } from './errors.js';
import {
  asArray,
  asBoolean,
  asNullableNumber,
  asNullableString,
  asNumber,
  asObject,
  asString,
  requestJson,
} from './json.js';

export const QA_RUNS_PATH = '/api/qa-runs';
export const QA_TRIES_PATH = '/api/qa-tries';

/**
 * `QaTryController.list` 가 `size !in 1..100` 이면 400 이다. CLI 가 이 값을 알고 있어야
 * 서버 왕복 없이 거절할 수 있다.
 */
export const MAX_QA_TRY_LIST_SIZE = 100;
export const DEFAULT_QA_TRY_LIST_SIZE = 20;
export const QA_STATS_PATH = '/api/qa-stats';
export const QA_MODELS_PATH = '/api/qa-models';

/**
 * `QaTryResponse`(orchestration `qa/dto/QaDtos.kt`)에서 CLI 가 쓰는 필드만.
 *
 * `reasoningEffort` 는 응답에 승격된 필드가 아니라 [runConfig] 안의 `reasoning.effort` 다.
 * 서버는 그 값을 `qa_try.reasoning_effort` 컬럼에도 갖고 있지만 `QaTryResponse` 로 내보내지
 * 않으므로, `qa diff` 의 축과 `qa show` 가 말하는 값을 맞추려면 여기서 스냅샷을 읽는 수밖에
 * 없다. 스냅샷이 없거나 `reasoning` 이 null 이면 null 이다 — 그것은 effort 가 없다는 뜻이지
 * 기본값이라는 뜻이 아니다.
 */
export interface QaTry {
  id: string;
  testScenarioId: string;
  gameInstanceId: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  model: string | null;
  promptVersion: string | null;
  reasoningEffort: string | null;
  agentArch: string | null;
  agentFingerprint: string | null;
  /**
   * 이 try 가 속한 `qa_run`. `qa_run` 이 생기기 전의 단독 실행 try 는 `null` 이다.
   *
   * `qa show`·`qa watch`·`qa cancel` 이 받는 것은 run id 이므로, try 목록에서 본 것을 다시
   * 열려면 이 값이 있어야 한다.
   */
  qaRunId: string | null;
}

/** `QaRunResponse`. `tries` 는 시나리오 순서대로이고 실행 전부터 전부 들어 있다(PENDING). */
export interface QaRun {
  id: string;
  testRunId: string;
  gameInstanceId: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  tries: QaTry[];
}

/** 런 생명주기의 종단 상태. QA 판정이 아니다 — 판정은 `qa/verdict.ts` 가 따로 읽는다. */
export const TERMINAL_QA_STATUSES: readonly string[] = ['COMPLETED', 'FAILED', 'CANCELLED'];

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_QA_STATUSES.includes(status);
}

/** `QaLogResponse`. `payload` 는 서버가 구조를 강제하지 않으므로 파싱하지 않고 그대로 든다. */
export interface QaLog {
  id: string;
  qaTryId: string;
  direction: string;
  type: string;
  message: string | null;
  payload: unknown;
  createdAt: string;
}

/** `IssueResponse` 에서 CLI 가 쓰는 필드만. `detail` 은 Agent payload 전체라 싣지 않는다. */
export interface QaIssue {
  id: string;
  qaTryId: string;
  severity: string;
  title: string;
  status: string;
  reportedAt: string;
}

/**
 * `QaRunConfigStatsCell` 의 숫자 부분. `QaStatsTotals` 와 같은 필드 집합이라 한 타입이다.
 *
 * 전부 **합계**다. 서버가 비율 대신 합계를 주는 이유는 `QaStatsDtos.kt` 에 적혀 있다 —
 * 비율만 주면 그것이 몇 개의 런에 얹힌 값인지가 응답에서 사라진다. `qa diff` 는 그 규율을
 * 이어받아 셀을 더할 때도 합계만 더하고, 비율은 출력 직전에 합계로부터 낸다.
 */
export interface QaStatsMetrics {
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
  /** 유일한 비합계 값. 완주한 런만의 평균이라 셀을 합칠 때 `completed` 로 가중해야 한다. */
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

/** 축 네 개 + 합계 한 줄. 축 값이 null 이면 "미상"이고, 그것은 축이 없는 것과 다르다. */
export interface QaStatsCell extends QaStatsMetrics {
  model: string | null;
  reasoningEffort: string | null;
  promptVersion: string | null;
  agentArch: string | null;
}

export interface QaStats {
  projectId: string | null;
  from: string;
  to: string;
  total: QaStatsMetrics;
  cells: QaStatsCell[];
  truncated: boolean;
  cellLimit: number;
}

export interface CreateQaRunRequest {
  testRunId: string;
  gameInstanceId: string;
  model?: string | undefined;
  promptVersion?: string | undefined;
  reasoning?: { effort?: string | undefined; maxTokens?: number | undefined } | undefined;
  arch?: unknown;
  /**
   * 이 런에 content map 을 얼마나 열어 줄지: `on`/`frozen`/`off`.
   *
   * 키가 **없는 것**과 값이 빈 문자열인 것은 다르다. 없으면 서버가 `run_config` 에 키를 싣지
   * 않고 기본값(`on`)으로 읽지만, 빈 문자열은 값으로 읽혀 400 이 된다. 그래서 이 세 필드는
   * 다른 선택 필드들과 같이 `undefined` 일 때 spread 에서 통째로 빠진다.
   */
  contentMapMode?: string | undefined;
  /** 이 런에 지식창고를 얼마나 열어 줄지: `learning`/`frozen`/`off`. [contentMapMode] 와 같은 규칙. */
  knowledgeMode?: string | undefined;
  /**
   * 이 런이 속한 실험 묶음의 이름. **arm 을 적는 자리가 아니다** — 무엇으로 돌았는지는
   * `run_config` 가 이미 말하므로, 여기 `arm:map-only` 같은 것을 적으면 같은 사실이 두 군데
   * 남고 언젠가 어긋난다.
   */
  label?: string | undefined;
  force?: boolean | undefined;
}

/**
 * `POST /api/qa-runs`. 409 셋은 상태코드로 갈리지 않고 `code` 로 갈린다(`QaConflicts.kt`).
 * 그 셋을 서로 다른 CLI 오류 코드로 옮기는 것은, `qa_run_active` 만이 `--force` 로 되돌릴 수
 * 있는 **선택지**이고 나머지 둘은 사람이 뭔가 고쳐야 하는 상태이기 때문이다.
 */
export async function createQaRun(
  apiBaseUrl: string,
  cliToken: string,
  request: CreateQaRunRequest,
  fetchImpl?: FetchLike,
): Promise<QaRun> {
  const endpoint = `${apiBaseUrl}${QA_RUNS_PATH}`;
  const body = await requestJson({
    method: 'POST',
    endpoint,
    cliToken,
    body: request,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    onFailure: (failure) => {
      switch (failure.code) {
        case 'sdk_disconnected':
          return new CliError(
            'qa_sdk_disconnected',
            `Game instance ${request.gameInstanceId} has no SDK connected, so no QA run can start on it. Launch the build with "artel game start" and try again.`,
          );
        case 'qa_run_active':
          return new CliError(
            'qa_run_active',
            `Game instance ${request.gameInstanceId} already has a QA run that has not finished. Re-run with --force to end it and take the instance over.`,
          );
        case 'test_run_empty':
          return new CliError(
            'qa_test_run_empty',
            `Test run ${request.testRunId} has no scenarios to execute.`,
          );
        default:
          return null;
      }
    },
  });
  return parseQaRun(body, endpoint);
}

export async function getQaRun(
  apiBaseUrl: string,
  cliToken: string,
  qaRunId: string,
  fetchImpl?: FetchLike,
): Promise<QaRun> {
  const endpoint = `${apiBaseUrl}${QA_RUNS_PATH}/${encodeURIComponent(qaRunId)}`;
  const body = await requestJson({
    method: 'GET',
    endpoint,
    cliToken,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    onFailure: (failure) =>
      failure.status === 404
        ? new CliError('qa_run_not_found', `There is no QA run ${qaRunId}, or you cannot see it.`)
        : null,
  });
  return parseQaRun(body, endpoint);
}

/** `POST /api/qa-runs/{id}/cancel`. 이미 끝난 런은 409 다. */
export async function cancelQaRun(
  apiBaseUrl: string,
  cliToken: string,
  qaRunId: string,
  fetchImpl?: FetchLike,
): Promise<void> {
  const endpoint = `${apiBaseUrl}${QA_RUNS_PATH}/${encodeURIComponent(qaRunId)}/cancel`;
  await requestJson({
    method: 'POST',
    endpoint,
    cliToken,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    onFailure: (failure) => {
      if (failure.status === 404) {
        return new CliError(
          'qa_run_not_found',
          `There is no QA run ${qaRunId}, or you cannot see it.`,
        );
      }
      if (failure.status === 409) {
        return new CliError(
          'qa_run_not_active',
          `QA run ${qaRunId} has already finished, so there is nothing to cancel.`,
        );
      }
      return null;
    },
  });
}

/**
 * 이 try 의 로그 마지막 한 페이지. 오름차순이므로 종단 STATUS frame 은 맨 뒤에 있다.
 *
 * 전체 로그를 훑지 않는다: 서버의 stream 은 종단 frame 에서 멈추므로 그 뒤로 붙는 frame 이
 * 없고, 판정을 읽는 데 필요한 것은 그 한 장뿐이다.
 */
/**
 * 한 프로젝트의 최근 시도. 새것부터 온다.
 *
 * 서버가 받는 것은 `projectId` 와 `size` 둘뿐이다 (`QaTryController.list`). `label` 이나
 * `status` 로 거르는 query parameter 는 없고, `label` 은 `QaTryResponse` 에 실리지도 않는다 —
 * 그 값은 `qa_run` 에 붙는다. 그래서 CLI 는 받은 것 안에서만 거를 수 있다.
 *
 * `size` 는 서버가 1 에서 100 사이로 강제한다. 벗어나면 400 이므로 부르는 쪽이 미리 막는다.
 */
export async function listQaTries(
  apiBaseUrl: string,
  cliToken: string,
  projectId: string,
  size: number,
  fetchImpl?: FetchLike,
): Promise<QaTry[]> {
  const query = new URLSearchParams({ projectId, size: String(size) });
  const endpoint = `${apiBaseUrl}${QA_TRIES_PATH}?${query.toString()}`;
  const body = await requestJson({
    method: 'GET',
    endpoint,
    cliToken,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });
  return asArray(body, 'body', endpoint).map((item, index) =>
    parseQaTry(item, `[${String(index)}]`, endpoint),
  );
}

/** `QaReasoningCapability`. `efforts` 가 `--reasoning-effort` 에 넣을 수 있는 값이다. */
export interface QaModelReasoning {
  kind: string;
  efforts: string[] | null;
  minTokens: number | null;
  maxTokens: number | null;
}

/** `QaModelResponse` 에서 축 값을 고르는 데 쓰는 부분. */
export interface QaModel {
  id: string;
  label: string;
  provider: string;
  multimodal: boolean;
  reasoning: QaModelReasoning | null;
}

/**
 * 서버가 아는 model 목록. `--model` 에 넣을 수 있는 값이 이것이다.
 *
 * CLI 는 이 목록으로 `--model` 을 미리 검증하지 않는다. 런을 걸 때마다 목록을 받아 오면 서버
 * 왕복이 하나 늘고, 서버가 아는 목록은 CLI 배포보다 자주 바뀐다 — CLI 가 든 사본이 서버보다
 * 낡으면 실제로 되는 model 을 CLI 가 거절하게 된다.
 */
export async function listQaModels(
  apiBaseUrl: string,
  cliToken: string,
  fetchImpl?: FetchLike,
): Promise<QaModel[]> {
  const endpoint = `${apiBaseUrl}${QA_MODELS_PATH}`;
  const body = await requestJson({
    method: 'GET',
    endpoint,
    cliToken,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });
  return asArray(body, 'body', endpoint).map((item, index) =>
    parseQaModel(item, `[${String(index)}]`, endpoint),
  );
}

function parseQaModel(value: unknown, field: string, endpoint: string): QaModel {
  const model = asObject(value, field, endpoint);
  return {
    id: asString(model['id'], `${field}.id`, endpoint),
    label: asString(model['label'], `${field}.label`, endpoint),
    provider: asString(model['provider'], `${field}.provider`, endpoint),
    multimodal: model['multimodal'] === true,
    reasoning: parseQaModelReasoning(model['reasoning']),
  };
}

/**
 * 능력 서술이라 모양이 어긋나면 오류가 아니라 미상(null)이다. 이 값을 못 읽었다고 목록 전체를
 * 실패로 돌리면, model 이름을 확인하러 온 사람이 이름조차 못 본다.
 */
function parseQaModelReasoning(value: unknown): QaModelReasoning | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const reasoning = value as Record<string, unknown>;
  const kind = reasoning['kind'];
  if (typeof kind !== 'string' || kind.length === 0) {
    return null;
  }
  const efforts = reasoning['efforts'];
  return {
    kind,
    efforts: Array.isArray(efforts)
      ? efforts.filter((effort): effort is string => typeof effort === 'string')
      : null,
    minTokens: typeof reasoning['minTokens'] === 'number' ? reasoning['minTokens'] : null,
    maxTokens: typeof reasoning['maxTokens'] === 'number' ? reasoning['maxTokens'] : null,
  };
}

/**
 * 이 사용자에게 실제로 런이 있는 label 만 온다. `projectId` 를 생략하면 볼 수 있는 전
 * 프로젝트의 목록이고, 그것은 `qa diff` 가 프로젝트 없이도 집계하는 것과 같은 규칙이다.
 */
export async function listQaLabels(
  apiBaseUrl: string,
  cliToken: string,
  projectId: string | undefined,
  fetchImpl?: FetchLike,
): Promise<string[]> {
  const query = projectId === undefined ? '' : `?projectId=${encodeURIComponent(projectId)}`;
  const endpoint = `${apiBaseUrl}${QA_STATS_PATH}/labels${query}`;
  const body = await requestJson({
    method: 'GET',
    endpoint,
    cliToken,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });
  const envelope = asObject(body, 'body', endpoint);
  return asArray(envelope['labels'], 'labels', endpoint).map((item, index) =>
    asString(item, `labels[${String(index)}]`, endpoint),
  );
}

export async function getQaTryLogTail(
  apiBaseUrl: string,
  cliToken: string,
  qaTryId: string,
  size: number,
  fetchImpl?: FetchLike,
): Promise<QaLog[]> {
  const endpoint = `${apiBaseUrl}${QA_TRIES_PATH}/${encodeURIComponent(qaTryId)}/logs?size=${String(size)}`;
  const body = await requestJson({
    method: 'GET',
    endpoint,
    cliToken,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });
  const page = asObject(body, 'body', endpoint);
  return asArray(page['items'], 'items', endpoint).map((item, index) =>
    parseQaLog(item, `items[${String(index)}]`, endpoint),
  );
}

export async function listQaTryIssues(
  apiBaseUrl: string,
  cliToken: string,
  qaTryId: string,
  size: number,
  fetchImpl?: FetchLike,
): Promise<QaIssue[]> {
  const endpoint = `${apiBaseUrl}${QA_TRIES_PATH}/${encodeURIComponent(qaTryId)}/issues?size=${String(size)}`;
  const body = await requestJson({
    method: 'GET',
    endpoint,
    cliToken,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });
  const page = asObject(body, 'body', endpoint);
  return asArray(page['items'], 'items', endpoint).map((item, index) => {
    const field = `items[${String(index)}]`;
    const issue = asObject(item, field, endpoint);
    return {
      id: asString(issue['id'], `${field}.id`, endpoint),
      qaTryId: asString(issue['qaTryId'], `${field}.qaTryId`, endpoint),
      severity: asString(issue['severity'], `${field}.severity`, endpoint),
      title: asString(issue['title'], `${field}.title`, endpoint),
      status: asString(issue['status'], `${field}.status`, endpoint),
      reportedAt: asString(issue['reportedAt'], `${field}.reportedAt`, endpoint),
    };
  });
}

export interface QaStatsQuery {
  projectId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

export async function getQaStats(
  apiBaseUrl: string,
  cliToken: string,
  query: QaStatsQuery,
  fetchImpl?: FetchLike,
): Promise<QaStats> {
  const search = new URLSearchParams();
  if (query.projectId !== undefined) {
    search.set('projectId', query.projectId);
  }
  if (query.from !== undefined) {
    search.set('from', query.from);
  }
  if (query.to !== undefined) {
    search.set('to', query.to);
  }
  const suffix = search.size === 0 ? '' : `?${search.toString()}`;
  const endpoint = `${apiBaseUrl}${QA_STATS_PATH}${suffix}`;
  const body = await requestJson({
    method: 'GET',
    endpoint,
    cliToken,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });
  const stats = asObject(body, 'body', endpoint);
  return {
    projectId: asNullableString(stats['projectId'], 'projectId', endpoint),
    from: asString(stats['from'], 'from', endpoint),
    to: asString(stats['to'], 'to', endpoint),
    total: parseMetrics(asObject(stats['total'], 'total', endpoint), 'total', endpoint),
    cells: asArray(stats['cells'], 'cells', endpoint).map((cell, index) => {
      const field = `cells[${String(index)}]`;
      const record = asObject(cell, field, endpoint);
      return {
        model: asNullableString(record['model'], `${field}.model`, endpoint),
        reasoningEffort: asNullableString(
          record['reasoningEffort'],
          `${field}.reasoningEffort`,
          endpoint,
        ),
        promptVersion: asNullableString(
          record['promptVersion'],
          `${field}.promptVersion`,
          endpoint,
        ),
        agentArch: asNullableString(record['agentArch'], `${field}.agentArch`, endpoint),
        ...parseMetrics(record, field, endpoint),
      };
    }),
    truncated: asBoolean(stats['truncated'], 'truncated', endpoint),
    cellLimit: asNumber(stats['cellLimit'], 'cellLimit', endpoint),
  };
}

/**
 * `GET /api/qa-tries/{id}/events` 를 연다. body 를 읽는 것은 호출자(`qa/follow.ts`)의 일이다 —
 * 이 함수는 stream 을 소비하지 않으므로 timeout 을 걸지 않는다. QA 런은 몇 분에서 몇 시간이고,
 * 그 사이 frame 이 없는 구간이 정상이다.
 */
export async function openQaTryEvents(
  apiBaseUrl: string,
  cliToken: string,
  qaTryId: string,
  afterId: string,
  signal: AbortSignal,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<Response> {
  const endpoint = `${apiBaseUrl}${QA_TRIES_PATH}/${encodeURIComponent(qaTryId)}/events?afterId=${encodeURIComponent(afterId)}`;

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'GET',
      headers: { authorization: `Bearer ${cliToken}`, accept: 'text/event-stream' },
      signal,
    });
  } catch (error) {
    throw new CliError(
      'network_error',
      `Could not reach ${endpoint}: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }

  if (!response.ok) {
    let text: string;
    try {
      text = await response.text();
    } catch {
      text = '';
    }
    throw toCliError(endpoint, parseHttpFailure(response.status, text));
  }

  return response;
}

function parseQaRun(body: unknown, endpoint: string): QaRun {
  const run = asObject(body, 'body', endpoint);
  return {
    id: asString(run['id'], 'id', endpoint),
    testRunId: asString(run['testRunId'], 'testRunId', endpoint),
    gameInstanceId: asString(run['gameInstanceId'], 'gameInstanceId', endpoint),
    status: asString(run['status'], 'status', endpoint),
    startedAt: asString(run['startedAt'], 'startedAt', endpoint),
    completedAt: asNullableString(run['completedAt'], 'completedAt', endpoint),
    tries: asArray(run['tries'] ?? [], 'tries', endpoint).map((item, index) =>
      parseQaTry(item, `tries[${String(index)}]`, endpoint),
    ),
  };
}

function parseQaTry(value: unknown, field: string, endpoint: string): QaTry {
  const qaTry = asObject(value, field, endpoint);
  return {
    id: asString(qaTry['id'], `${field}.id`, endpoint),
    testScenarioId: asString(qaTry['testScenarioId'], `${field}.testScenarioId`, endpoint),
    gameInstanceId: asString(qaTry['gameInstanceId'], `${field}.gameInstanceId`, endpoint),
    status: asString(qaTry['status'], `${field}.status`, endpoint),
    startedAt: asString(qaTry['startedAt'], `${field}.startedAt`, endpoint),
    completedAt: asNullableString(qaTry['completedAt'], `${field}.completedAt`, endpoint),
    model: asNullableString(qaTry['model'], `${field}.model`, endpoint),
    promptVersion: asNullableString(qaTry['promptVersion'], `${field}.promptVersion`, endpoint),
    reasoningEffort: readReasoningEffort(qaTry['runConfig']),
    agentArch: asNullableString(qaTry['agentArch'], `${field}.agentArch`, endpoint),
    agentFingerprint: asNullableString(
      qaTry['agentFingerprint'],
      `${field}.agentFingerprint`,
      endpoint,
    ),
    qaRunId: asNullableString(qaTry['qaRunId'], `${field}.qaRunId`, endpoint),
  };
}

/**
 * `runConfig.reasoning.effort`. 스냅샷은 Agent 가 만든 것이고 서버가 모양을 강제하지
 * 않으므로, 기대한 모양이 아니면 오류가 아니라 미상(null)이다.
 */
function readReasoningEffort(runConfig: unknown): string | null {
  if (typeof runConfig !== 'object' || runConfig === null || Array.isArray(runConfig)) {
    return null;
  }
  const reasoning = (runConfig as Record<string, unknown>)['reasoning'];
  if (typeof reasoning !== 'object' || reasoning === null || Array.isArray(reasoning)) {
    return null;
  }
  const effort = (reasoning as Record<string, unknown>)['effort'];
  return typeof effort === 'string' && effort.length > 0 ? effort : null;
}

function parseQaLog(value: unknown, field: string, endpoint: string): QaLog {
  const log = asObject(value, field, endpoint);
  return {
    id: asString(log['id'], `${field}.id`, endpoint),
    qaTryId: asString(log['qaTryId'], `${field}.qaTryId`, endpoint),
    direction: asString(log['direction'], `${field}.direction`, endpoint),
    type: asString(log['type'], `${field}.type`, endpoint),
    message: asNullableString(log['message'], `${field}.message`, endpoint),
    payload: log['payload'],
    createdAt: asString(log['createdAt'], `${field}.createdAt`, endpoint),
  };
}

/** `QaLogResponse` 한 건을 SSE `data:` 에서 읽는다. 형식이 어긋나면 `null` 이고, 호출자가 건너뛴다. */
export function parseQaLogEvent(data: string): QaLog | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const log = parsed as Record<string, unknown>;
  if (typeof log['id'] !== 'string' || typeof log['type'] !== 'string') {
    return null;
  }
  return {
    id: log['id'],
    qaTryId: typeof log['qaTryId'] === 'string' ? log['qaTryId'] : '',
    direction: typeof log['direction'] === 'string' ? log['direction'] : '',
    type: log['type'],
    message: typeof log['message'] === 'string' ? log['message'] : null,
    payload: log['payload'],
    createdAt: typeof log['createdAt'] === 'string' ? log['createdAt'] : '',
  };
}

function parseMetrics(
  record: Record<string, unknown>,
  field: string,
  endpoint: string,
): QaStatsMetrics {
  const count = (key: keyof QaStatsMetrics): number =>
    asNumber(record[key], `${field}.${key}`, endpoint);
  return {
    runs: count('runs'),
    completed: count('completed'),
    failed: count('failed'),
    cancelled: count('cancelled'),
    active: count('active'),
    inputTokens: count('inputTokens'),
    outputTokens: count('outputTokens'),
    cachedInputTokens: count('cachedInputTokens'),
    reasoningTokens: count('reasoningTokens'),
    costUsd: asNullableNumber(record['costUsd'], `${field}.costUsd`, endpoint),
    llmCalls: count('llmCalls'),
    avgCompletedDurationMs: asNullableNumber(
      record['avgCompletedDurationMs'],
      `${field}.avgCompletedDurationMs`,
      endpoint,
    ),
    verdictKnown: count('verdictKnown'),
    stepsTotal: count('stepsTotal'),
    stepsPassed: count('stepsPassed'),
    casesTotal: count('casesTotal'),
    casesPassed: count('casesPassed'),
    scoredRuns: count('scoredRuns'),
    correctPass: count('correctPass'),
    falseAlarm: count('falseAlarm'),
    miss: count('miss'),
    correctFail: count('correctFail'),
    unreported: count('unreported'),
  };
}
