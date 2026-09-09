import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CliError } from '../src/errors.js';
import type { QaMatrixCombinationPayload } from '../src/output/contract.js';
import { appendRun, readJournal, rejectForeignRuns, runKey } from '../src/qa/journal.js';
import { expandCombinations, type MatrixAxes } from '../src/qa/matrix.js';

function axes(partial: Partial<MatrixAxes> = {}): MatrixAxes {
  return {
    testRunIds: ['1'],
    models: [null],
    promptVersions: [null],
    reasoningEfforts: [null],
    contentMapModes: [null],
    knowledgeModes: [null],
    ...partial,
  };
}

function finishedRun(
  overrides: Partial<QaMatrixCombinationPayload> = {},
): QaMatrixCombinationPayload {
  return {
    index: 0,
    combination: 0,
    repeat: 0,
    slot: 0,
    build: '/games/BuildA/WordVenture.exe',
    testRunId: '1',
    model: null,
    promptVersion: null,
    reasoningEffort: null,
    contentMapMode: null,
    knowledgeMode: null,
    gameInstanceId: '10',
    qaRunId: '9',
    status: 'COMPLETED',
    verdict: 'PASSED',
    stepsPassed: 3,
    stepsTotal: 3,
    usage: null,
    durationMs: 1000,
    error: null,
    ...overrides,
  };
}

let dir: string;
let journal: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'artel-journal-'));
  journal = path.join(dir, 'matrix.jsonl');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('the matrix journal', () => {
  it('reads back what it appended, one run per line', async () => {
    await appendRun(journal, finishedRun({ index: 0 }));
    await appendRun(journal, finishedRun({ index: 1, repeat: 1, qaRunId: '10' }));

    const read = await readJournal(journal);

    expect(read.map((run) => run.qaRunId)).toEqual(['9', '10']);
    expect((await fs.readFile(journal, 'utf8')).trimEnd().split('\n')).toHaveLength(2);
  });

  /** 첫 실행에 `--resume` 을 준 것은 오류가 아니라 "이어 돌릴 것이 없다" 이다. */
  it('treats a file that is not there as nothing to resume', async () => {
    expect(await readJournal(path.join(dir, 'never-written.jsonl'))).toEqual([]);
  });

  /**
   * 망가진 줄을 건너뛰면 그 런을 돌지 않은 것으로 보고 다시 돌린다. 서버에는 그 런이 이미
   * 있으므로 한 실험에 같은 설정의 런이 둘 생긴다.
   */
  it('refuses a file with a line it cannot read, instead of skipping it', async () => {
    await appendRun(journal, finishedRun());
    await fs.appendFile(journal, 'not json\n', 'utf8');

    const failure = (await readJournal(journal).catch((error: unknown) => error)) as CliError;

    expect(failure.code).toBe('matrix_journal_unreadable');
    expect(failure.message).toContain('line 2');
  });

  /**
   * 열쇠는 축 값과 반복 번호다. 전개 순서 번호를 쓰면 `--model` 을 하나 더한 것만으로 같은
   * 번호가 다른 설정을 가리키고, `--resume` 이 돌지 않은 설정을 건너뛴다.
   */
  it('keys a run by its axis values, not by where it sat in the order', () => {
    const before = expandCombinations(axes({ contentMapModes: ['off', 'frozen'] }));
    const after = expandCombinations(
      axes({ models: ['openai/gpt-5.6-luna'], contentMapModes: ['off', 'frozen'] }),
    );

    // 축이 하나 늘어도 `off` 조합의 index 는 0 으로 같다. 그런데 설정은 다르다.
    expect(before[0]?.index).toBe(after[0]?.index);
    expect(runKey(before[0]!)).not.toBe(runKey(after[0]!));
  });

  it('accepts a journal whose runs are all inside the current product', () => {
    const combinations = expandCombinations(axes({ contentMapModes: ['off', 'frozen'] }));
    const done = [finishedRun({ contentMapMode: 'off' })];

    expect(() => {
      rejectForeignRuns(journal, done, combinations);
    }).not.toThrow();
  });

  /** 다른 실험의 파일에 이어 쓰면 한 표에 두 실험이 섞이고, 읽는 사람은 그것을 알 길이 없다. */
  it('refuses a journal holding a run this command would never produce', () => {
    const combinations = expandCombinations(axes({ contentMapModes: ['off'] }));
    const done = [finishedRun({ contentMapMode: 'frozen' })];

    const failure = (() => {
      try {
        rejectForeignRuns(journal, done, combinations);
        return null;
      } catch (error) {
        return error as CliError;
      }
    })();

    expect(failure?.code).toBe('matrix_journal_mismatch');
    expect(failure?.message).toContain('contentMap=frozen');
  });
});
