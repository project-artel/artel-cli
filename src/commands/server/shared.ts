import { CliError } from '../../errors.js';
import type { OutputSink } from '../../output/envelope.js';
import { SupervisorError } from '../../server/errors.js';
import { defaultDataDir } from '../../server/paths.js';

/** supervisor 는 `CliError` 를 모른다. 명령의 경계에서 같은 `code` 로 옮긴다. */
export async function withSupervisorErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof SupervisorError) throw new CliError(error.code, error.message);
    throw error;
  }
}

export function commandDataDir(env: NodeJS.ProcessEnv): string {
  return defaultDataDir(env);
}

/** 테스트가 GitHub Releases 대신 local HTTP fixture 를 가리키게 하는 값. */
export interface ServerDownloadDeps {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export interface DownloadProgressReporter {
  message: (line: string) => void;
  bytes: (received: number, total: number | null) => void;
  done: () => void;
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * runtime 을 받는 진행 상황을 stderr 에 쓴다. terminal 이면 한 줄을 제자리에서 바꾸고, 아니면
 * 10% 마다(크기를 모르면 10 MB 마다) 한 줄씩 쓴다. stdout 은 `--json` payload 자리라 쓰지 않는다.
 */
export function downloadProgressReporter(sink: OutputSink): DownloadProgressReporter {
  let lastStep = -1;
  let lastLive = '';
  return {
    message(line) {
      sink.err(line);
    },
    bytes(received, total) {
      const percent = total === null ? null : Math.floor((received / total) * 100);
      const line =
        percent === null || total === null
          ? `  ${megabytes(received)}`
          : `  ${megabytes(received)} / ${megabytes(total)} (${String(percent)}%)`;
      if (sink.status !== undefined) {
        if (line !== lastLive) sink.status(line);
        lastLive = line;
        return;
      }
      const step =
        percent === null ? Math.floor(received / (10 * 1024 * 1024)) : Math.floor(percent / 10);
      if (step !== lastStep) {
        lastStep = step;
        sink.err(line);
      }
    },
    done() {
      if (sink.status !== undefined && lastLive !== '') sink.status(null);
    },
  };
}
