import { resolveConfig } from '../../config.js';
import { resolveCredential } from '../../credentials/resolve.js';
import { CliError } from '../../errors.js';
import { EXIT_FAILURE, EXIT_OK } from '../../exit.js';
import {
  defaultGameStartDeps,
  runGameStartFlow,
  type GameStartDeps,
} from '../../game/start-flow.js';
import type { SpawnedGameProcess } from '../../game/process.js';
import type { FetchLike } from '../../http/client.js';
import { cancelQaRun, createQaRun } from '../../http/qa.js';
import type { QaMatrixCombinationPayload, QaMatrixPayload } from '../../output/contract.js';
import { writeJsonPayload, type OutputSink } from '../../output/envelope.js';
import { describeFollowEvent, printQaMatrix } from '../../output/human.js';
import { readArch } from '../../qa/arch.js';
import {
  appendRun,
  keyOfCombination,
  readJournal,
  rejectForeignRuns,
  runKey,
} from '../../qa/journal.js';
import type { QaContext } from '../../qa/context.js';
import type { QaFollowEvent } from '../../qa/follow.js';
import {
  assignToSlots,
  describeCombination,
  expandCombinations,
  type AxisValue,
  type MatrixCombination,
} from '../../qa/matrix.js';
import { followToPayload } from './watch.js';

export interface QaMatrixCommandOptions {
  json: boolean;
  project: string;
  testRunIds: readonly string[];
  models: readonly AxisValue[];
  promptVersions: readonly AxisValue[];
  reasoningEfforts: readonly AxisValue[];
  contentMapModes: readonly AxisValue[];
  knowledgeModes: readonly AxisValue[];
  /**
   * 전 조합에 걸리는 고정값. 축이 아니다.
   *
   * `--reasoning-max-tokens` 는 model 과 effort 가 정해진 뒤의 예산이라, 그 둘을 축으로 두고
   * 이것까지 축으로 두면 서로 맞지 않는 조합이 곱해진다. `--arch` 는 JSON object 하나여서
   * 쉼표로 가를 수 없다 — 목록으로 받으려면 파일 여러 개를 받는 다른 flag 모양이 필요하고,
   * 그것은 이 이슈가 푸는 문제가 아니다.
   */
  reasoningMaxTokens?: number | undefined;
  /**
   * 조합 하나를 몇 번 돌릴지. 1 이면 지금 동작 그대로다.
   *
   * QA agent 의 런은 결정적이지 않다. 조합당 한 번씩 돌린 표로 두 arm 을 비교하면, 본 차이가
   * arm 때문인지 그날의 운인지 구분할 수 없다.
   */
  repeats: number;
  /** `--out`. 런이 끝날 때마다 여기에 한 줄씩 붙인다. */
  out?: string | undefined;
  /** `--resume`. [out] 에 이미 있는 런을 건너뛴다. */
  resume: boolean;
  /** `--arch` 의 원문. JSON object 이거나 `@경로`. */
  arch?: string | undefined;
  label?: string | undefined;
  /** `--slot` 을 적은 순서. 첨자가 슬롯 번호다. */
  slots: readonly string[];
  width: number;
  height: number;
  launchTimeoutSeconds: number;
  timeoutSeconds: number;
  apiUrl?: string | undefined;
  consoleUrl?: string | undefined;
  /** 테스트가 폴링과 재연결을 빠르게 돌리는 자리. 평소에는 기본값을 쓴다. */
  pollIntervalMs?: number | undefined;
  reconnectDelaysMs?: readonly number[] | undefined;
}

/**
 * 축 조합을 여러 게임에 나눠 돌린다.
 *
 * ## 슬롯이 무엇인가
 *
 * 슬롯 하나는 게임 빌드 하나이고, 한 번에 런 하나만 돈다. 한 게임 인스턴스에 두 런을 겹쳐
 * 걸면 뒤엣것이 앞엣것을 끊으므로(서버가 `qa_run_active` 로 막고 `--force` 로만 뚫린다),
 * 슬롯은 병렬 단위가 아니라 **작업 큐**다.
 *
 * ## 왜 슬롯마다 빌드가 달라야 하나
 *
 * `sdk_uuid`(`ArtelSdkIdentity`)와 게임의 `StagePosition`(`SaveLoadController`)이 둘 다
 * `PlayerPrefs` 에 있고, Windows 에서 그 저장 경로는 `productName` 으로 갈린다. 그래서 같은
 * `productName` 을 가진 빌드를 둘 띄우면 두 인스턴스가 하나로 접히고 세이브가 서로를
 * 덮어쓴다. CLI 는 빌드를 만들지 않는다 — 사람이 `productName` 이 서로 다른 빌드를 미리
 * 준비해 `--slot` 으로 경로를 넘긴다. 같은 경로를 두 번 적은 것만 CLI 가 막을 수 있고,
 * 경로가 달라도 `productName` 이 같으면 막지 못한다.
 *
 * ## 왜 런마다 게임을 다시 띄우나
 *
 * 앞 런이 게임을 전투 화면에 두고 끝나면 다음 런의 첫 스텝("타이틀 화면 관찰")이 거기서
 * 시작한다. 조합 비교가 그것 때문에 깨지므로, 조합 하나가 끝날 때마다 그 슬롯의 게임을 죽이고
 * 다음 조합을 위해 다시 띄운다. 첫 조합도 같다 — 이 명령이 띄운 게임에서만 돈다.
 *
 * ## 하나가 실패해도 나머지는 돈다
 *
 * 조합 하나의 실패는 그 조합의 기록으로 남고 같은 슬롯의 다음 조합이 이어 돈다. 전체 exit
 * code 는 조합 하나라도 통과하지 못하면 0 이 아니다.
 */
export async function runQaMatrix(
  options: QaMatrixCommandOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
  makeStartDeps: (notify: (message: string) => void) => GameStartDeps = (notify) =>
    defaultGameStartDeps(notify, env),
  fetchImpl?: FetchLike,
): Promise<number> {
  // 자격증명을 먼저 읽는다. 파일에 적힌 `apiBaseUrl` 이 주소의 마지막 후보다.
  const resolution = await resolveCredential(env);
  if (resolution.credential === null) {
    throw new CliError(
      'no_credential',
      'Not signed in. Run "artel auth login" first, or set ARTEL_TOKEN.',
    );
  }
  const config = resolveConfig(
    env,
    { apiBaseUrl: options.apiUrl, consoleBaseUrl: options.consoleUrl },
    resolution.credential.stored?.apiBaseUrl ?? null,
  );
  const context: QaContext = {
    apiBaseUrl: config.apiBaseUrl,
    cliToken: resolution.credential.token,
  };

  const combinations = expandCombinations(
    {
      testRunIds: options.testRunIds,
      models: options.models,
      promptVersions: options.promptVersions,
      reasoningEfforts: options.reasoningEfforts,
      contentMapModes: options.contentMapModes,
      knowledgeModes: options.knowledgeModes,
    },
    options.repeats,
  );
  const slots = assignToSlots(combinations, options.slots.length);
  const total = combinations.length;

  // 슬롯당 대기열 길이까지 말한다. 축이 다섯이 되면서 조합 수가 곱으로 늘어나고, 슬롯 하나가
  // 몇 개를 차례로 돌아야 하는지가 이 명령이 몇 시간짜리인지를 정한다 — 시작하기 전에 그것을
  // 보고 그만둘 수 있어야 한다.
  // 이어 돌릴 것을 먼저 읽는다. 축이 어긋나면 게임을 하나도 띄우기 전에 멈춰야 한다.
  const done = new Map<string, QaMatrixCombinationPayload>();
  if (options.resume && options.out !== undefined) {
    const journal = await readJournal(options.out);
    rejectForeignRuns(options.out, journal, combinations);
    for (const run of journal) {
      done.set(runKey(run), run);
    }
    if (done.size > 0) {
      sink.err(`Resuming: ${String(done.size)} run(s) already in ${options.out}.`);
    }
  }

  const longestQueue = Math.max(...slots.map((assigned) => assigned.length));
  const runs =
    options.repeats === 1
      ? `${String(total)} combinations`
      : `${String(total)} runs (${String(total / options.repeats)} combinations × ${String(options.repeats)})`;
  sink.err(
    `Running ${runs} over ${String(options.slots.length)} slots — up to ${String(longestQueue)} in a row on one slot.`,
  );

  // 전개 순서대로 자리를 미리 잡아 둔다. 슬롯이 병렬로 끝나므로, 끝난 순서대로 밀어 넣으면
  // 같은 명령이 매번 다른 순서의 payload 를 낸다.
  const results = new Array<QaMatrixCombinationPayload | null>(combinations.length).fill(null);
  const launchGate = createLaunchGate();
  // 한 번만 읽는다. 조합마다 다시 읽으면 matrix 가 도는 중에 파일이 바뀌었을 때 앞뒤 조합이
  // 다른 구조로 돌고, 그 차이는 결과 어디에도 남지 않는다.
  const arch = await readArch(options.arch);

  await Promise.all(
    slots.map((assigned, slot) =>
      runSlot(assigned, slot, total, options, context, config.consoleBaseUrl, env, sink, results, {
        makeStartDeps,
        launchGate,
        done,
        ...(arch === undefined ? {} : { arch }),
        ...(fetchImpl === undefined ? {} : { fetchImpl }),
      }),
    ),
  );

  const combinationPayloads = results.filter(
    (result): result is QaMatrixCombinationPayload => result !== null,
  );
  const succeeded = combinationPayloads.filter((result) => result.verdict === 'PASSED').length;

  const payload: QaMatrixPayload = {
    label: options.label ?? null,
    projectId: options.project,
    slots: [...options.slots],
    total: combinationPayloads.length,
    succeeded,
    failed: combinationPayloads.length - succeeded,
    combinations: combinationPayloads,
  };

  if (options.json) {
    writeJsonPayload(sink, payload);
  } else {
    printQaMatrix(sink, payload);
  }
  return payload.failed === 0 ? EXIT_OK : EXIT_FAILURE;
}

interface SlotDeps {
  makeStartDeps: (notify: (message: string) => void) => GameStartDeps;
  fetchImpl?: FetchLike | undefined;
  /** `--resume` 이 읽어 둔, 이미 끝난 런. 열쇠는 축 값과 반복 번호다. */
  done: ReadonlyMap<string, QaMatrixCombinationPayload>;
  /**
   * `--arch` 를 읽어 둔 값. 조합마다 다시 읽지 않는다 — 파일을 매번 읽으면 matrix 가 도는
   * 중에 그 파일이 바뀌었을 때 앞뒤 조합이 다른 구조로 돌고, 그 차이는 결과 어디에도 안 남는다.
   */
  arch?: unknown;
  /** 등록을 한 번에 하나씩만 시키는 문. [createLaunchGate] 참고. */
  launchGate: LaunchGate;
}

type LaunchGate = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * 게임 등록을 한 번에 하나만 시킨다.
 *
 * `game/registration.ts` 는 launch 전후로 project 의 game instance 목록을 두 번 불러 그
 * 차이로 이번에 등록된 것을 찾는다. 등록 요청을 보낸 쪽과 목록에 나타난 행을 잇는 값이
 * 없어서다. 그래서 두 슬롯이 같은 순간에 등록하면 두 후보가 같은 차이 안에 들어오고, 한
 * 슬롯이 다른 슬롯의 instance 를 자기 것으로 집을 수 있다 — 그러면 두 조합이 게임 하나에
 * 겹쳐 걸린다.
 *
 * 등록은 몇 초고 런은 몇 분이라, 등록만 직렬화해도 전체 시간은 거의 그대로다. 런은 여전히
 * 슬롯 수만큼 겹쳐 돈다.
 */
function createLaunchGate(): LaunchGate {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const result = tail.then(task, task);
    tail = result.catch(() => undefined);
    return result;
  };
}

/** 슬롯 하나가 받은 조합을 차례로 돈다. 한 번에 런 하나다. */
async function runSlot(
  assigned: readonly MatrixCombination[],
  slot: number,
  total: number,
  options: QaMatrixCommandOptions,
  context: QaContext,
  consoleBaseUrl: string,
  env: NodeJS.ProcessEnv,
  sink: OutputSink,
  results: (QaMatrixCombinationPayload | null)[],
  deps: SlotDeps,
): Promise<void> {
  const build = options.slots[slot];
  if (build === undefined) {
    return;
  }

  for (const combination of assigned) {
    // 이미 끝난 런은 게임을 띄우지 않고 파일에서 읽은 결과를 그대로 쓴다. 다시 돌리면 서버에
    // 같은 설정의 런이 둘 생기고, 그 둘 중 어느 것이 표에 들어갔는지 알 수 없게 된다.
    const already = deps.done.get(keyOfCombination(combination));
    if (already !== undefined) {
      sink.err(
        `[slot ${String(slot)}] run ${String(combination.index + 1)}/${String(total)}: already in the journal (run ${already.qaRunId ?? '-'}), skipping.`,
      );
      results[combination.index] = already;
      continue;
    }

    const result = await runCombination(
      combination,
      slot,
      total,
      build,
      options,
      context,
      consoleBaseUrl,
      env,
      sink,
      deps,
    );
    results[combination.index] = result;

    // 런이 끝난 직후에 적는다. 모아 두었다가 끝에 쓰면 이 기능이 푸는 문제가 그대로 남는다.
    if (options.out !== undefined) {
      await appendRun(options.out, result);
    }
  }
}

async function runCombination(
  combination: MatrixCombination,
  slot: number,
  total: number,
  build: string,
  options: QaMatrixCommandOptions,
  context: QaContext,
  consoleBaseUrl: string,
  env: NodeJS.ProcessEnv,
  sink: OutputSink,
  deps: SlotDeps,
): Promise<QaMatrixCombinationPayload> {
  const startedAt = Date.now();
  const progress = (message: string): void => {
    sink.err(`[slot ${String(slot)}] ${message}`);
  };
  progress(
    `run ${String(combination.index + 1)}/${String(total)}: ${describeCombination(combination, options.repeats)}`,
  );

  const base = {
    index: combination.index,
    combination: combination.combination,
    repeat: combination.repeat,
    slot,
    build,
    testRunId: combination.testRunId,
    model: combination.model,
    promptVersion: combination.promptVersion,
    reasoningEffort: combination.reasoningEffort,
    contentMapMode: combination.contentMapMode,
    knowledgeMode: combination.knowledgeMode,
  };

  // 실패한 launch 도 게임 창을 남길 수 있다(등록 timeout 은 게임이 살아 있는 채로 던진다).
  // spawn 을 감싸 자식을 붙들어야 성공 경로와 실패 경로 양쪽에서 같은 방법으로 죽일 수 있다.
  const launched: { child: SpawnedGameProcess | null } = { child: null };
  let gameInstanceId: string | null = null;
  let qaRunId: string | null = null;

  try {
    const startDeps = recordSpawnedChild(deps.makeStartDeps(progress), launched);
    const started = await deps.launchGate(() =>
      runGameStartFlow(
        {
          apiBaseUrl: context.apiBaseUrl,
          consoleBaseUrl,
          cliToken: context.cliToken,
          build,
          projectId: options.project,
          width: options.width,
          height: options.height,
          // 조합을 나란히 놓고 보려고 게임 여럿을 한 화면에 띄운다. 전체 화면은 서로를 덮는다.
          fullscreen: false,
          registrationTimeoutMs: options.launchTimeoutSeconds * 1_000,
          processEnv: env,
        },
        startDeps,
      ),
    );
    gameInstanceId = started.instance.id;

    const created = await createQaRun(
      context.apiBaseUrl,
      context.cliToken,
      {
        testRunId: combination.testRunId,
        gameInstanceId: started.instance.id,
        // 안 준 축은 키 자체를 싣지 않는다. 빈 문자열은 서버가 값으로 읽어 400 이 된다.
        ...(combination.model === null ? {} : { model: combination.model }),
        ...(combination.promptVersion === null ? {} : { promptVersion: combination.promptVersion }),
        ...(combination.reasoningEffort === null && options.reasoningMaxTokens === undefined
          ? {}
          : {
              reasoning: {
                ...(combination.reasoningEffort === null
                  ? {}
                  : { effort: combination.reasoningEffort }),
                ...(options.reasoningMaxTokens === undefined
                  ? {}
                  : { maxTokens: options.reasoningMaxTokens }),
              },
            }),
        ...(deps.arch === undefined ? {} : { arch: deps.arch }),
        ...(combination.contentMapMode === null
          ? {}
          : { contentMapMode: combination.contentMapMode }),
        ...(combination.knowledgeMode === null ? {} : { knowledgeMode: combination.knowledgeMode }),
        ...(options.label === undefined ? {} : { label: options.label }),
        // `--force` 를 열지 않는다. 이 명령은 자기가 띄운 게임에서만 돌므로, 남의 런을 끊어야
        // 하는 상황은 이 슬롯이 앞 조합을 제대로 치우지 못했다는 뜻이고 그것은 숨길 일이 아니다.
        force: false,
      },
      deps.fetchImpl,
    );
    qaRunId = created.id;
    progress(`started QA run ${created.id}`);

    const finished = await followToPayload(
      context,
      created.id,
      {
        json: options.json,
        timeoutSeconds: options.timeoutSeconds,
        ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
        ...(options.reconnectDelaysMs === undefined
          ? {}
          : { reconnectDelaysMs: options.reconnectDelaysMs }),
      },
      (event: QaFollowEvent) => {
        sink.err(
          options.json
            ? JSON.stringify({ slot, combination: combination.index, event })
            : `[slot ${String(slot)}] ${describeFollowEvent(event)}`,
        );
      },
      deps.fetchImpl,
    );

    return {
      ...base,
      gameInstanceId,
      qaRunId: created.id,
      status: finished.status,
      verdict: finished.verdict,
      stepsPassed: finished.steps.passed,
      stepsTotal: finished.steps.total,
      usage: finished.usage,
      durationMs: Date.now() - startedAt,
      error: null,
    };
  } catch (error) {
    const failure = describeFailure(error);
    progress(`combination ${String(combination.index + 1)} failed: ${failure.message}`);

    // 이 슬롯의 다음 조합이 같은 게임 인스턴스에 붙었다가 `qa_run_active` 로 막히는 것을
    // 막는다. 취소 자체가 실패해도 이 조합은 이미 실패라 더 보고할 것이 없다.
    if (qaRunId !== null) {
      await cancelQaRun(context.apiBaseUrl, context.cliToken, qaRunId, deps.fetchImpl).catch(
        () => undefined,
      );
    }

    return {
      ...base,
      gameInstanceId,
      qaRunId,
      status: qaRunId === null ? 'NOT_STARTED' : 'CANCELLED',
      verdict: null,
      stepsPassed: null,
      stepsTotal: null,
      usage: null,
      durationMs: Date.now() - startedAt,
      error: failure,
    };
  } finally {
    killQuietly(launched.child);
  }
}

/** `runGameStartFlow` 가 띄운 자식을 붙든다. flow 는 성공 경로에서만 그것을 돌려준다. */
function recordSpawnedChild(
  deps: GameStartDeps,
  launched: { child: SpawnedGameProcess | null },
): GameStartDeps {
  return {
    ...deps,
    spawn: async (command, args, spawnEnv) => {
      const child = await deps.spawn(command, args, spawnEnv);
      launched.child = child;
      return child;
    },
  };
}

/**
 * 게임을 끝낸다. 이미 죽은 자식에게 보내는 signal 은 던지므로 삼킨다 — 조합이 실패한 이유가
 * 게임이 일찍 죽은 것이었다면 그 사실은 이미 기록돼 있고, 뒤늦은 `kill` 오류가 그것을 덮으면
 * 안 된다.
 */
function killQuietly(child: SpawnedGameProcess | null): void {
  if (child === null) {
    return;
  }
  try {
    child.kill();
  } catch {
    // 이미 끝난 프로세스다.
  }
}

function describeFailure(error: unknown): NonNullable<QaMatrixCombinationPayload['error']> {
  if (error instanceof CliError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: 'internal_error',
    message: error instanceof Error ? error.message : 'unknown error',
  };
}
