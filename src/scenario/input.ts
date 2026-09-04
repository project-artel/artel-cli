import fs from 'node:fs/promises';

import { UsageError } from '../errors.js';

/**
 * `--steps`/`--labels` 는 command-line argument 를 받지 않는다 — 파일 경로거나 표준입력이다.
 * `psql` 로 시나리오를 손으로 끼워 넣었던 사고가 보여준 것은, 큰 JSON 을 셸 인용부호 안에
 * 우겨 넣는 자리일수록 모양이 깨지기 쉽다는 것이다.
 *
 * `path` 가 없거나 `"-"` 면 표준입력을 읽는다. 그 자리에서 터미널이 상호작용형(파이프되지
 * 않음)이면 조용히 매달리는 대신 즉시 거절한다 — `path` 를 명시적으로 `"-"` 로 준 경우는
 * 예외다: 사용자가 표준입력을 쓰겠다고 말했으므로 그 요청을 그대로 따른다.
 */
export async function readFromFileOrStdin(
  path: string | undefined,
  flagLabel: string,
  stdin: NodeJS.ReadableStream = process.stdin,
): Promise<string> {
  if (path !== undefined && path !== '-') {
    try {
      return await fs.readFile(path, 'utf8');
    } catch (error) {
      throw new UsageError(
        `Could not read ${flagLabel} from ${path}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  if (path === undefined && isInteractiveTty(stdin)) {
    throw new UsageError(
      `${flagLabel} needs input: pass ${flagLabel} <path>, or pipe JSON into standard input.`,
    );
  }

  return await readAll(stdin);
}

function isInteractiveTty(stream: NodeJS.ReadableStream): boolean {
  return (stream as { isTTY?: boolean }).isTTY === true;
}

function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer | string) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
    });
    stream.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    stream.on('error', (error: Error) => {
      reject(error);
    });
  });
}
