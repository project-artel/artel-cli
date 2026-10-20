import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';

/** 한 log 파일의 상한. 넘으면 `.1` 로 밀어내고 새로 연다. */
export const DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024;
/** 밀어낸 파일을 몇 개까지 남기는가. `.1` 이 가장 최근이다. */
export const DEFAULT_LOG_KEEP = 3;

/**
 * `postgres` 는 supervisor 가 쓰는 initdb, pg_ctl, createdb 출력이고, `postgres-server` 는
 * `pg_ctl -l` 로 postgres 자신이 쓰는 log 다. 둘을 한 파일에 두면 Windows 에서 기동이 실패한다:
 * pg_ctl 은 `cmd.exe` 의 `>>` redirect 로 log 를 여는데, 그 redirect 는 다른 handle 이 쓰기로 열어
 * 둔 파일을 열지 못하고, postgres 가 도는 동안은 반대로 supervisor 가 그 파일에 쓰지 못한다.
 */
export type LogFileName =
  | 'postgres'
  | 'postgres-server'
  | 'orchestration'
  | 'agent-server'
  | 'proxy'
  | 'supervisor';

export const LOG_FILE_NAMES: readonly LogFileName[] = [
  'supervisor',
  'postgres',
  'postgres-server',
  'orchestration',
  'agent-server',
  'proxy',
];

export function logFilePath(logDir: string, name: LogFileName): string {
  return path.join(logDir, `${name}.log`);
}

/** 크기 기준으로 돌리는 append 전용 log 파일. 줄 단위로만 쓴다. */
export class RotatingLog {
  private fd: number | null = null;
  private size = 0;

  constructor(
    readonly file: string,
    private readonly maxBytes = DEFAULT_LOG_MAX_BYTES,
    private readonly keep = DEFAULT_LOG_KEEP,
  ) {}

  write(line: string): void {
    const fd = this.open();
    const bytes = Buffer.from(`${line}\n`, 'utf8');
    fs.writeSync(fd, bytes);
    this.size += bytes.length;
    if (this.size >= this.maxBytes) {
      this.rotate();
    }
  }

  close(): void {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }

  private open(): number {
    if (this.fd === null) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      this.fd = fs.openSync(this.file, 'a');
      this.size = fs.fstatSync(this.fd).size;
    }
    return this.fd;
  }

  private rotate(): void {
    this.close();
    rotateLogFile(this.file, this.keep);
    this.size = 0;
  }
}

/** `<file>.<keep-1>` 를 `<file>.<keep>` 로, …, `<file>` 을 `<file>.1` 로 옮긴다. */
export function rotateLogFile(file: string, keep = DEFAULT_LOG_KEEP): void {
  fs.rmSync(`${file}.${String(keep)}`, { force: true });
  for (let index = keep - 1; index >= 1; index -= 1) {
    const from = `${file}.${String(index)}`;
    if (fs.existsSync(from)) fs.renameSync(from, `${file}.${String(index + 1)}`);
  }
  if (fs.existsSync(file)) fs.renameSync(file, `${file}.1`);
}

/** 파일이 상한을 넘었으면 돌린다. postgres 처럼 파일을 직접 여는 process 를 띄우기 전에 쓴다. */
export function rotateIfLarge(file: string, maxBytes = DEFAULT_LOG_MAX_BYTES): void {
  try {
    if (fs.statSync(file).size >= maxBytes) rotateLogFile(file);
  } catch {
    // 파일이 아직 없으면 돌릴 것도 없다.
  }
}

/** stream 을 줄로 나누어 `onLine` 에 넘긴다. */
export function forEachLine(stream: Readable, onLine: (line: string) => void): void {
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  reader.on('line', onLine);
}

export interface FileFollower {
  stop(): void;
}

/**
 * 파일 끝에 붙는 줄을 `intervalMs` 마다 읽는다. `fs.watch` 는 OS 마다 동작이 달라 polling 을
 * 쓴다. 파일이 줄어들면(돌려졌으면) 처음부터 다시 읽는다.
 */
export function followFile(
  file: string,
  onLine: (line: string) => void,
  options: { fromStart?: boolean; intervalMs?: number } = {},
): FileFollower {
  let offset = options.fromStart ? 0 : safeSize(file);
  let pending = '';
  const timer = setInterval(() => {
    const size = safeSize(file);
    if (size < offset) {
      offset = 0;
      pending = '';
    }
    if (size === offset) return;
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(size - offset);
      fs.readSync(fd, buffer, 0, buffer.length, offset);
      offset = size;
      const text = pending + buffer.toString('utf8');
      const lines = text.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) onLine(line);
    } finally {
      fs.closeSync(fd);
    }
  }, options.intervalMs ?? 500);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

function safeSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** 파일 끝의 `count` 줄. 큰 파일 전체를 메모리에 올리지 않도록 끝에서부터 최대 1 MB 만 읽는다. */
export function readLastLines(file: string, count: number): string[] {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return [];
  }
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, 1024 * 1024);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();
    return lines.slice(-count);
  } finally {
    fs.closeSync(fd);
  }
}
