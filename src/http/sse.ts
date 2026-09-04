import { CliError } from '../errors.js';

/**
 * SSE frame 한 장.
 *
 * `event` 는 `event:` 줄이고 `data` 는 `data:` 줄을 개행으로 이은 것이다. orchestration 의
 * 문서·content map stream 은 `event:` 이름과 payload 의 `type` 을 같은 값으로 보내지만,
 * 둘 다 읽어 두고 판단은 호출부에 맡긴다.
 *
 * `qa/follow.ts` 의 `readQaLogStream` 이 같은 일을 한다. 그쪽을 이 모듈로 옮기지 않는 이유는
 * 그 stream 이 `afterId` cursor 로 이어받는 다른 재연결 규율을 쓰기 때문이다 — 여기 있는
 * [watchSse] 는 cursor 없이 다시 붙어 snapshot 으로 맞추는 stream 만 다룬다.
 */
export interface SseFrame {
  event: string | null;
  data: string;
}

/** HTTP 응답 body 를 frame 하나씩으로 읽는다. 서버가 끊거나 signal 이 abort 되면 끝난다. */
export async function* readSseFrames(response: Response): AsyncGenerator<SseFrame> {
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
        const frame = readBlock(block);
        if (frame !== null) {
          yield frame;
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

/** `data:` 가 한 줄도 없는 block 은 주석이나 keep-alive 라 frame 이 아니다. */
function readBlock(block: string): SseFrame | null {
  const data: string[] = [];
  let event: string | null = null;
  for (const rawLine of block.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.startsWith('data:')) {
      data.push(line.slice('data:'.length).replace(/^ /, ''));
      continue;
    }
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).replace(/^ /, '');
    }
  }
  return data.length === 0 ? null : { event, data: data.join('\n') };
}

export interface SseWatchOptions<TResult> {
  /** stream 을 연다. 재연결마다 다시 불린다. */
  open(signal: AbortSignal): Promise<Response>;
  /** 이 frame 으로 끝났으면 결과를, 아직이면 `null` 을 돌려준다. */
  read(frame: SseFrame): TResult | null;
  /** `0` 이면 상한 없음. */
  timeoutMs: number;
  reconnectDelaysMs: readonly number[];
  onReconnect(attempt: number, of: number, delayMs: number): void;
  onTimeout(): CliError;
  onDisconnected(attempts: number): CliError;
}

/**
 * 종단 frame 이 올 때까지 stream 을 읽고, 끊기면 다시 붙는다.
 *
 * **cursor 를 들지 않는다.** 이 두 stream 은 구독 직후 `snapshot` 을 한 번 보내므로, 다시
 * 붙는 것이 곧 현재 상태로 맞추는 것이다 — 끊긴 사이에 놓친 중간 상태는 있어도 결과는
 * 놓치지 않는다. `qa/follow.ts` 가 `afterId` 로 frame 하나까지 이어받는 것과 다른 이유는
 * 그쪽이 로그 한 줄씩을 보고해야 하기 때문이다.
 *
 * **서버가 먼저 끊지 않는다.** 그래서 stream 이 닫혔다는 것 자체가 이상 신호이고, 재연결
 * 횟수를 다 쓰면 통과도 실패도 아닌 [SseWatchOptions.onDisconnected] 로 끝낸다.
 */
export async function watchSse<TResult>(options: SseWatchOptions<TResult>): Promise<TResult> {
  const deadline = new AbortController();
  const timer =
    options.timeoutMs > 0
      ? setTimeout(() => {
          deadline.abort();
        }, options.timeoutMs)
      : null;
  let attempt = 0;

  try {
    for (;;) {
      const stream = new AbortController();
      try {
        const response = await options.open(AbortSignal.any([stream.signal, deadline.signal]));
        for await (const frame of readSseFrames(response)) {
          attempt = 0;
          const result = options.read(frame);
          if (result !== null) {
            return result;
          }
        }
      } catch (error) {
        // network 오류와 abort 는 재연결 대상이다. 그 밖의 CliError(404·권한 등)는 다시
        // 붙어도 같은 답이 오므로 그대로 올린다.
        if (error instanceof CliError && error.code !== 'network_error') {
          throw error;
        }
        if (!(error instanceof CliError) && !isAbort(error)) {
          throw error;
        }
      } finally {
        stream.abort();
      }

      if (deadline.signal.aborted) {
        throw options.onTimeout();
      }

      attempt += 1;
      const delayMs = options.reconnectDelaysMs[attempt - 1];
      if (delayMs === undefined) {
        throw options.onDisconnected(options.reconnectDelaysMs.length);
      }
      options.onReconnect(attempt, options.reconnectDelaysMs.length, delayMs);
      await sleep(delayMs, deadline.signal);
      if (deadline.signal.aborted) {
        throw options.onTimeout();
      }
    }
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
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
