import fs from 'node:fs/promises';

import { CliError } from '../errors.js';
import type { QaMatrixCombinationPayload } from '../output/contract.js';
import type { MatrixCombination } from './matrix.js';

/**
 * 끝난 런을 한 줄씩 적어 두는 파일. JSON Lines 다.
 *
 * 한 줄에 하나씩 쓰는 이유는 중간에 죽어도 그때까지가 온전한 파일이어야 하기 때문이다. 배열
 * 하나로 감싸면 닫는 괄호가 없어 파일 전체가 못 읽는 것이 된다.
 *
 * 줄의 모양은 `--json` 의 조합 결과와 같다. 같은 사실을 두 모양으로 적으면 언젠가 어긋난다.
 */

/**
 * 런 하나를 알아보는 열쇠.
 *
 * 전개 순서 번호(`index`)를 쓰지 않는다. 그 번호는 축 목록에서 나온 값이라, `--model` 을 하나
 * 더하면 같은 번호가 다른 설정을 가리킨다 — 그러면 `--resume` 이 돌지 않은 설정을 돌았다고
 * 읽고 건너뛴다. 축 값과 반복 번호는 그 설정 자체이므로 목록이 바뀌어도 뜻이 변하지 않는다.
 */
export function runKey(run: {
  testRunId: string;
  model: string | null;
  promptVersion: string | null;
  reasoningEffort: string | null;
  contentMapMode: string | null;
  knowledgeMode: string | null;
  repeat: number;
}): string {
  return JSON.stringify([
    run.testRunId,
    run.model,
    run.promptVersion,
    run.reasoningEffort,
    run.contentMapMode,
    run.knowledgeMode,
    run.repeat,
  ]);
}

export function keyOfCombination(combination: MatrixCombination): string {
  return runKey(combination);
}

/**
 * 런 하나를 파일 끝에 붙인다. 런이 끝난 직후에 부른다 — 모아 두었다가 끝에 쓰면 이 기능이
 * 푸는 문제가 그대로 남는다.
 */
export async function appendRun(path: string, run: QaMatrixCombinationPayload): Promise<void> {
  try {
    await fs.appendFile(path, `${JSON.stringify(run)}\n`, 'utf8');
  } catch (error) {
    throw new CliError(
      'matrix_journal_unwritable',
      `Could not append to ${path}: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
}

/**
 * 이미 끝난 런들을 읽는다. 파일이 없으면 빈 목록이다 — 첫 실행에 `--resume` 을 준 것은
 * 오류가 아니라 "이어 돌릴 것이 없다" 이다.
 *
 * 한 줄이라도 읽히지 않으면 거절한다. 망가진 줄을 건너뛰면 그 런을 돌지 않은 것으로 보고 다시
 * 돌리게 되는데, 서버에는 그 런이 이미 있으므로 한 실험에 같은 설정의 런이 둘 생긴다.
 */
export async function readJournal(path: string): Promise<QaMatrixCombinationPayload[]> {
  let text: string;
  try {
    text = await fs.readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw new CliError(
      'matrix_journal_unreadable',
      `Could not read ${path}: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }

  const runs: QaMatrixCombinationPayload[] = [];
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new CliError(
        'matrix_journal_unreadable',
        `${path} line ${String(index + 1)} is not valid JSON. Fix or remove that line; skipping it would run a combination the server already has.`,
      );
    }
    runs.push(parsed as QaMatrixCombinationPayload);
  }
  return runs;
}

/**
 * 파일에 적힌 런이 지금 명령의 축 곱 안에 있는지 본다.
 *
 * 다른 실험의 파일에 이어 쓰면 한 표에 두 실험이 섞이고, 그 표를 읽는 사람은 자기가 무엇을
 * 비교했는지 모른다. 그래서 하나라도 밖에 있으면 시작 전에 멈춘다.
 */
export function rejectForeignRuns(
  path: string,
  journal: readonly QaMatrixCombinationPayload[],
  combinations: readonly MatrixCombination[],
): void {
  const wanted = new Set(combinations.map(keyOfCombination));
  const foreign = journal.filter((run) => !wanted.has(runKey(run)));
  if (foreign.length === 0) {
    return;
  }
  const first = foreign[0];
  throw new CliError(
    'matrix_journal_mismatch',
    `${path} holds ${String(foreign.length)} run(s) this command would not produce — the first is testRun=${first?.testRunId ?? '-'} model=${first?.model ?? 'server default'} contentMap=${first?.contentMapMode ?? 'server default'} knowledge=${first?.knowledgeMode ?? 'server default'} repeat=${String((first?.repeat ?? 0) + 1)}. That file belongs to a different set of axes; resuming onto it would put two experiments in one table.`,
  );
}
