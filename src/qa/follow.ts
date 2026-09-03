import { CliError } from '../errors.js';
import type { FetchLike } from '../http/client.js';
import {
  getQaRun,
  isTerminalStatus,
  openQaTryEvents,
  parseQaLogEvent,
  type QaLog,
  type QaRun,
  type QaTry,
} from '../http/qa.js';
import { isTerminalFrame, readStepFrame, readTerminalFrame, type QaVerdict } from './verdict.js';

/**
 * `watch` 가 보고하는 사건. 사람용 한 줄과 `--json` 의 NDJSON 한 줄이 모두 이것 하나에서
 * 나오므로, 두 출력이 서로 다른 것을 말하는 일이 생기지 않는다.
 */
export type QaFollowEvent =
  | { kind: 'run-status'; status: string }
  | {
      kind: 'try-start';
      tryId: string;
      testScenarioId: string;
      /** 1 부터. `of` 는 이 런의 시나리오 수다. */
      index: number;
      of: number;
    }
  | {
      kind: 'step';
      tryId: string;
      step: number;
      passed: boolean;
      caseId: string | null;
      message: string | null;
    }
  | { kind: 'issue'; tryId: string; severity: string; title: string }
  | { kind: 'error'; tryId: string; message: string }
  | { kind: 'try-end'; tryId: string; status: string; verdict: QaVerdict }
  | { kind: 'reconnect'; tryId: string; attempt: number; of: number; delayMs: number };

/**
 * 끊긴 stream 을 다시 잇는 간격. frame 이 하나라도 도착하면 시도 횟수는 0 으로 돌아간다 —
 * 몇 시간짜리 런에서 중간에 한 번 끊긴 것과, 서버가 아예 없어진 것은 다른 일이다.
 */
export const DEFAULT_RECONNECT_DELAYS_MS: readonly number[] = [500, 1_000, 2_000, 4_000, 8_000];

export const DEFAULT_POLL_INTERVAL_MS = 5_000;

export interface FollowQaRunOptions {
  apiBaseUrl: string;
  cliToken: string;
  qaRunId: string;
  onEvent: (event: QaFollowEvent) => void;
  fetchImpl?: FetchLike | undefined;
  /** 0 이면 제한 없음. */
  timeoutMs: number;
  pollIntervalMs?: number | undefined;
  reconnectDelaysMs?: readonly number[] | undefined;
}

/**
 * 런 하나를 끝까지 따라간다.
 *
 * ## 왜 run 을 폴링하면서 try 의 stream 을 읽나
 *
 * SSE 는 `qa_try` 하나에만 붙는다. 런은 시나리오마다 try 를 하나씩 갖고, 실행 전부터 전부
 * `PENDING` 으로 존재한다. 그래서 순서대로 하나씩 붙는다.
 *
 * 그런데 서버의 stream 은 아직 끝나지 않은 try 에 대해서는 250ms 마다 테이블을 다시 볼 뿐
 * 스스로 끝나지 않는다. 런이 취소되어 `PENDING` 인 채로 남은 try 에 붙으면 영원히 기다린다.
 * 그래서 stream 을 읽는 동안 런 상태를 따로 폴링하고, 런이 종단이면 stream 을 끊는다.
 *
 * ## 끊긴 연결
 *
 * frame 을 하나도 잃지 않는다: 서버는 `afterId` 로 이어 받으므로 마지막으로 본 id 부터 다시
 * 요청한다. 재연결은 [DEFAULT_RECONNECT_DELAYS_MS] 만큼만 시도하고, 그것을 다 쓰면 런을 한 번
 * 더 조회한다 — 그 사이에 런이 끝나 있으면 성공이다(판정은 stream 이 아니라 로그에서 읽으므로
 * 연결이 끊겼다는 사실이 결과를 바꾸지 않는다). 아직 돌고 있으면 `qa_watch_disconnected` 로
 * 실패한다. **끊긴 연결을 실패한 테스트로 보고하지 않고, 통과로도 보고하지 않는다.**
 */
export async function followQaRun(options: FollowQaRunOptions): Promise<QaRun> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const reconnectDelays = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
  const deadline = new AbortController();
  const timer =
    options.timeoutMs > 0
      ? setTimeout(() => {
          deadline.abort();
        }, options.timeoutMs)
      : null;

  const cursors = new Map<string, string>();
  const announcedTries = new Set<string>();
  /**
   * 종단 frame 을 이미 읽은 try. 서버가 그 try 의 상태를 옮기는 것과 우리가 frame 을 보는
   * 것은 같은 순간이 아니라, 이 기억이 없으면 방금 끝난 try 에 다시 붙는다. 그 stream 은
   * 이어받을 frame 이 없어 곧장 닫히고, 그것이 끊긴 연결로 읽혀 재연결을 전부 소모한다.
   */
  const finishedTries = new Set<string>();
  let announcedStatus: string | null = null;

  try {
    let run = await getQaRun(
      options.apiBaseUrl,
      options.cliToken,
      options.qaRunId,
      options.fetchImpl,
    );

    for (;;) {
      if (run.status !== announcedStatus) {
        announcedStatus = run.status;
        options.onEvent({ kind: 'run-status', status: run.status });
      }
      if (isTerminalStatus(run.status)) {
        return run;
      }
      assertNotTimedOut(deadline.signal, options.timeoutMs);

      const active = run.tries.find(
        (qaTry) => !isTerminalStatus(qaTry.status) && !finishedTries.has(qaTry.id),
      );
      if (active === undefined) {
        // 마지막 try 는 끝났는데 런의 rollup 이 아직 안 돈 구간. 다음 폴링을 기다린다.
        await sleep(pollIntervalMs, deadline.signal);
        assertNotTimedOut(deadline.signal, options.timeoutMs);
        run = await getQaRun(
          options.apiBaseUrl,
          options.cliToken,
          options.qaRunId,
          options.fetchImpl,
        );
        continue;
      }

      if (!announcedTries.has(active.id)) {
        announcedTries.add(active.id);
        options.onEvent({
          kind: 'try-start',
          tryId: active.id,
          testScenarioId: active.testScenarioId,
          index: run.tries.indexOf(active) + 1,
          of: run.tries.length,
        });
      }

      const outcome = await followTry({
        ...options,
        deadlineSignal: deadline.signal,
        pollIntervalMs,
        reconnectDelays,
        cursors,
        qaTry: active,
      });
      if (outcome.finished) {
        finishedTries.add(active.id);
      }
      run = outcome.run;
    }
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

interface FollowTryOptions extends FollowQaRunOptions {
  deadlineSignal: AbortSignal;
  pollIntervalMs: number;
  reconnectDelays: readonly number[];
  cursors: Map<string, string>;
  qaTry: QaTry;
}

interface FollowTryOutcome {
  run: QaRun;
  /** 이 try 의 종단 frame 을 읽었는가. 읽었으면 다시 붙지 않는다. */
  finished: boolean;
}

/** try 하나의 stream 을 종단 frame 이나 런 종료까지 읽고, 그때의 런 상태를 돌려준다. */
async function followTry(options: FollowTryOptions): Promise<FollowTryOutcome> {
  const { qaTry, cursors } = options;
  let attempt = 0;

  for (;;) {
    const stream = new AbortController();
    const watchdog = startRunWatchdog(options, stream);
    let sawTerminalFrame = false;

    try {
      const response = await openQaTryEvents(
        options.apiBaseUrl,
        options.cliToken,
        qaTry.id,
        cursors.get(qaTry.id) ?? '0',
        AbortSignal.any([stream.signal, options.deadlineSignal]),
        options.fetchImpl,
      );

      for await (const log of readQaLogStream(response)) {
        attempt = 0;
        cursors.set(qaTry.id, log.id);
        emitLog(options, qaTry.id, log);
        if (isTerminalFrame(log)) {
          sawTerminalFrame = true;
          break;
        }
      }
    } catch (error) {
      if (!isAbort(error)) {
        // network 오류는 재연결 대상이다. 그 밖의 CliError(권한·404 등)는 그대로 올린다.
        if (error instanceof CliError && error.code !== 'network_error') {
          throw error;
        }
      }
    } finally {
      stream.abort();
      await watchdog.stop();
    }

    assertNotTimedOut(options.deadlineSignal, options.timeoutMs);

    if (sawTerminalFrame) {
      // 폴링이 들고 있는 snapshot 은 이 frame 보다 오래됐을 수 있다. 다시 읽는다.
      return {
        run: await getQaRun(
          options.apiBaseUrl,
          options.cliToken,
          options.qaRunId,
          options.fetchImpl,
        ),
        finished: true,
      };
    }
    const polled = watchdog.latestRun();
    if (polled !== null && watchdog.runIsTerminal()) {
      return { run: polled, finished: false };
    }

    attempt += 1;
    const delayMs = options.reconnectDelays[attempt - 1];
    if (delayMs === undefined) {
      // 재시도를 다 썼다. 그 사이에 런이 끝나 있으면 결과는 로그에서 읽으면 되므로 성공이다.
      const latest = await getQaRun(
        options.apiBaseUrl,
        options.cliToken,
        options.qaRunId,
        options.fetchImpl,
      );
      if (isTerminalStatus(latest.status)) {
        return { run: latest, finished: false };
      }
      throw new CliError(
        'qa_watch_disconnected',
        `Lost the event stream for QA try ${qaTry.id} and could not reconnect after ${String(options.reconnectDelays.length)} attempts. QA run ${options.qaRunId} is still ${latest.status}; it keeps running on the server. Re-attach with "artel qa watch ${options.qaRunId}".`,
      );
    }
    options.onEvent({
      kind: 'reconnect',
      tryId: qaTry.id,
      attempt,
      of: options.reconnectDelays.length,
      delayMs,
    });
    await sleep(delayMs, options.deadlineSignal);
    assertNotTimedOut(options.deadlineSignal, options.timeoutMs);
  }
}

interface RunWatchdog {
  latestRun(): QaRun | null;
  runIsTerminal(): boolean;
  stop(): Promise<void>;
}

/**
 * stream 을 읽는 동안 런 상태를 따로 본다. 런이 종단이면 더 붙을 frame 이 없으므로 stream 을
 * 끊는다 — 취소되어 `PENDING` 인 채로 남은 try 에 붙었을 때 영원히 기다리지 않게 하는 것이
 * 이 감시의 존재 이유다.
 *
 * 종단을 본 뒤 곧장 끊지 않고 한 주기를 더 기다린다. 마지막 try 의 종단 frame 이 써지는 것과
 * 런의 rollup 은 거의 동시라, 즉시 끊으면 그 frame 을 stream 에서 놓치고 화면에 마지막 판정이
 * 안 나온다. 놓쳐도 최종 결과는 로그에서 다시 읽으므로 틀리지는 않지만, 굳이 놓칠 이유도 없다.
 */
function startRunWatchdog(options: FollowTryOptions, stream: AbortController): RunWatchdog {
  const stopper = new AbortController();
  let latest: QaRun | null = null;
  let terminal = false;

  const loop = (async () => {
    let sawTerminal = false;
    while (!stopper.signal.aborted) {
      await sleep(options.pollIntervalMs, stopper.signal);
      if (stopper.signal.aborted) {
        return;
      }
      try {
        latest = await getQaRun(
          options.apiBaseUrl,
          options.cliToken,
          options.qaRunId,
          options.fetchImpl,
        );
      } catch {
        // 폴링 실패는 지나간다. stream 쪽이 살아 있으면 그쪽이 계속 말해 준다.
        continue;
      }
      if (isTerminalStatus(latest.status)) {
        if (sawTerminal) {
          terminal = true;
          stream.abort();
          return;
        }
        sawTerminal = true;
      }
    }
  })();

  return {
    latestRun: () => latest,
    runIsTerminal: () => terminal,
    async stop() {
      stopper.abort();
      await loop;
    },
  };
}

function emitLog(options: FollowTryOptions, tryId: string, log: QaLog): void {
  const terminal = readTerminalFrame(log);
  if (terminal !== null) {
    options.onEvent({
      kind: 'try-end',
      tryId,
      status: terminal.status,
      verdict: terminal.verdict,
    });
    return;
  }

  const step = readStepFrame(log);
  if (step !== null) {
    options.onEvent({
      kind: 'step',
      tryId,
      step: step.step,
      passed: step.passed,
      caseId: step.caseId,
      message: step.message,
    });
    return;
  }

  if (log.type === 'ISSUE') {
    options.onEvent({
      kind: 'issue',
      tryId,
      severity: readStringField(log.payload, 'severity') ?? 'UNKNOWN',
      title: log.message ?? readStringField(log.payload, 'title') ?? '(no title)',
    });
    return;
  }

  if (log.type === 'ERROR') {
    options.onEvent({
      kind: 'error',
      tryId,
      message: log.message ?? readStringField(log.payload, 'reason') ?? '(no message)',
    });
  }
}

function readStringField(payload: unknown, field: string): string | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return null;
  }
  const value = (payload as Record<string, unknown>)[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * SSE body 를 `QaLogResponse` 하나씩으로 읽는다.
 *
 * `EventSource` 를 쓰지 않는 이유: Node 의 `EventSource` 는 요청 헤더를 받지 않아
 * `Authorization` 을 실을 수 없다. 그리고 재연결 정책은 이 CLI 가 직접 쥐어야 한다 —
 * `EventSource` 는 무한히 다시 붙고, CI 에서 그것은 끝나지 않는 job 이다.
 */
export async function* readQaLogStream(response: Response): AsyncGenerator<QaLog> {
  const body = response.body;
  if (body === null) {
    return;
  }
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      let separator = findSeparator(buffer);
      while (separator !== null) {
        const block = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator.length);
        const log = readSseBlock(block);
        if (log !== null) {
          yield log;
        }
        separator = findSeparator(buffer);
      }
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

function findSeparator(buffer: string): { index: number; length: number } | null {
  const doubleNewline = buffer.indexOf('\n\n');
  const carriage = buffer.indexOf('\r\n\r\n');
  if (carriage >= 0 && (doubleNewline < 0 || carriage < doubleNewline)) {
    return { index: carriage, length: 4 };
  }
  return doubleNewline < 0 ? null : { index: doubleNewline, length: 2 };
}

function readSseBlock(block: string): QaLog | null {
  const data: string[] = [];
  for (const rawLine of block.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.startsWith('data:')) {
      continue;
    }
    data.push(line.slice('data:'.length).replace(/^ /, ''));
  }
  return data.length === 0 ? null : parseQaLogEvent(data.join('\n'));
}

function assertNotTimedOut(signal: AbortSignal, timeoutMs: number): void {
  if (signal.aborted) {
    throw new CliError(
      'qa_watch_timeout',
      `Stopped watching after ${String(Math.round(timeoutMs / 1_000))}s. The QA run keeps going on the server; raise --timeout or re-attach with "artel qa watch".`,
    );
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
