import fs from 'node:fs/promises';

import { CliError } from '../errors.js';

/**
 * `case create`/`case update` 의 본문을 읽는 단 하나의 통로.
 *
 * 명령줄 인자로는 절대 받지 않는다 — 사전조건/기대결과는 여러 줄에 따옴표까지 섞인
 * 자연어라, 셸을 거치는 순간 CLI 가 보기도 전에 깨진다. `--file` 이 있으면 그 경로를,
 * 없으면 표준입력 전체를 읽는다.
 */
export async function readCaseBody(
  filePath: string | undefined,
  stdin: NodeJS.ReadableStream = process.stdin,
): Promise<string> {
  if (filePath !== undefined) {
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch (error) {
      throw new CliError(
        'case_invalid_body',
        `Could not read --file ${filePath}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }
  return await readStream(stdin);
}

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** JSON 으로 못 읽으면 어디서 왔는지(`--file` 경로인지 표준입력인지)를 그대로 말한다. */
export function parseCaseBody(text: string, filePath: string | undefined): unknown {
  if (text.trim().length === 0) {
    throw new CliError(
      'case_invalid_body',
      filePath === undefined
        ? 'No body was given on standard input.'
        : `--file ${filePath} is empty.`,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError(
      'case_invalid_body',
      `${filePath === undefined ? 'Standard input' : `--file ${filePath}`} is not valid JSON.`,
    );
  }
}
