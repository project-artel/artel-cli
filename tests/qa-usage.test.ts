import { afterEach, describe, expect, it } from 'vitest';

import { runQaShow } from '../src/commands/qa/show.js';
import type { LlmUsageTotals } from '../src/http/llmUsage.js';
import type { QaRunPayload } from '../src/output/contract.js';
import { EXIT_OK, runCli } from '../src/run.js';
import { sumUsage } from '../src/qa/usage.js';
import { createMemorySink } from './helpers.js';
import {
  fakeQaRun,
  fakeQaTry,
  startFakeQaServer,
  type FakeQaServer,
  type FakeUsageTotals,
} from './qa-helpers.js';

function totals(overrides: Partial<LlmUsageTotals> = {}): LlmUsageTotals {
  return {
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 40,
    reasoningTokens: 5,
    costUsd: 0.25,
    calls: 4,
    pricedCalls: 4,
    ...overrides,
  };
}

describe('sumUsage', () => {
  it('adds the sums', () => {
    const summed = sumUsage([totals(), totals({ inputTokens: 50, outputTokens: 10, calls: 2 })]);

    expect(summed).toMatchObject({ inputTokens: 150, outputTokens: 30, calls: 6 });
  });

  /**
   * 단가를 모르는 것과 공짜였던 것은 다르다. 둘을 같은 0 으로 접으면, 단가를 안 알려주는
   * provider 로 돌린 arm 이 공짜였던 것으로 읽히고 비용 비교가 조용히 틀린다.
   */
  it('keeps cost null when no try had a price at all', () => {
    const summed = sumUsage([totals({ costUsd: null, pricedCalls: 0 })]);

    expect(summed?.costUsd).toBeNull();
    expect(summed?.calls).toBe(4);
  });

  it('adds only the tries that carried a price, and says how many calls that was', () => {
    const summed = sumUsage([
      totals({ costUsd: 0.25, calls: 4, pricedCalls: 4 }),
      totals({ costUsd: null, calls: 3, pricedCalls: 0 }),
    ]);

    expect(summed?.costUsd).toBeCloseTo(0.25);
    expect(summed?.calls).toBe(7);
    expect(summed?.pricedCalls).toBe(4);
  });

  /** payload 가 `null` 이면 "못 읽었다" 이지 "0 을 썼다" 가 아니다. */
  it('is null when nothing could be read', () => {
    expect(sumUsage([null, null])).toBeNull();
  });

  it('ignores the tries it could not read instead of counting them as zero', () => {
    const summed = sumUsage([totals({ inputTokens: 100 }), null]);

    expect(summed?.inputTokens).toBe(100);
  });
});

let api: FakeQaServer | null = null;

afterEach(async () => {
  await api?.close();
  api = null;
});

const USAGE_A: FakeUsageTotals = {
  inputTokens: 100,
  outputTokens: 20,
  cachedInputTokens: 40,
  reasoningTokens: 5,
  costUsd: 0.25,
  calls: 4,
  pricedCalls: 4,
};

const USAGE_B: FakeUsageTotals = {
  inputTokens: 50,
  outputTokens: 10,
  cachedInputTokens: 0,
  reasoningTokens: 0,
  costUsd: null,
  calls: 3,
  pricedCalls: 0,
};

function runOfTwoTries() {
  return fakeQaRun({
    id: '9',
    status: 'COMPLETED',
    tries: [
      fakeQaTry('100', { status: 'COMPLETED' }),
      fakeQaTry('101', { status: 'COMPLETED', testScenarioId: '2' }),
    ],
  });
}

function envOf(): NodeJS.ProcessEnv {
  if (api === null) {
    throw new Error('the fake server was not started');
  }
  return { ARTEL_API_BASE_URL: api.baseUrl, ARTEL_TOKEN: 'artel_env_token' };
}

describe('qa show carries what the run spent', () => {
  it('sums the tries into the run', async () => {
    api = await startFakeQaServer({
      run: runOfTwoTries(),
      usage: { '100': USAGE_A, '101': USAGE_B },
    });
    const sink = createMemorySink();

    await runQaShow('9', { json: true }, sink, envOf());

    const payload = sink.lastJson<QaRunPayload>();
    expect(payload.usage).toMatchObject({ inputTokens: 150, calls: 7, pricedCalls: 4 });
    expect(payload.usage?.costUsd).toBeCloseTo(0.25);
    expect(payload.tries[0]?.usage).toMatchObject({ inputTokens: 100 });
    expect(payload.tries[1]?.usage?.costUsd).toBeNull();
  });

  /**
   * 판정을 읽는 것과 비용을 읽는 것은 다른 질문이다. 비용 조회가 죽었다고 `qa show` 가 판정을
   * 못 내면, 그 런이 통과했는지 물으러 온 사람이 답을 못 받는다.
   */
  it('still reports the verdict when the usage endpoint answers 404', async () => {
    api = await startFakeQaServer({ run: runOfTwoTries() });
    const sink = createMemorySink();

    // 명령 전체를 통과시켜 종료 코드까지 본다. 사용량을 못 읽은 것이 실패로 새어 나가면
    // 여기서 걸린다.
    const code = await runCli(['qa', 'show', '9', '--json'], sink, envOf());

    expect(code).toBe(EXIT_OK);
    const payload = sink.lastJson<QaRunPayload>();
    expect(payload.usage).toBeNull();
    expect(payload.runId).toBe('9');
  });

  it('writes the cost and how many calls it covers into the human output', async () => {
    api = await startFakeQaServer({
      run: runOfTwoTries(),
      usage: { '100': USAGE_A, '101': USAGE_B },
    });
    const sink = createMemorySink();

    await runQaShow('9', { json: false }, sink, envOf());

    expect(sink.stdout.join('\n')).toContain('4 of 7 call(s) priced');
  });

  it('says the usage was not read rather than printing a zero', async () => {
    api = await startFakeQaServer({ run: runOfTwoTries() });
    const sink = createMemorySink();

    await runQaShow('9', { json: false }, sink, envOf());

    expect(sink.stdout.join('\n')).toContain('usage          not read');
  });
});
