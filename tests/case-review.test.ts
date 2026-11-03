import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { runCaseCreate } from '../src/commands/case/create.js';
import { runCaseUpdate } from '../src/commands/case/update.js';
import { getTestCase, createTestCase } from '../src/http/testcase.js';
import type { CaseCreateBatchPayload, TestCasePayload } from '../src/output/contract.js';
import { EXIT_OK, EXIT_USAGE, runCli } from '../src/run.js';
import { fakeTestCase, startFakeCaseServer, type FakeCaseServer } from './case-helpers.js';
import { createMemorySink } from './helpers.js';

let api: FakeCaseServer;
const valid = { scene: 'Title', step: 'Start', expectedValue: 'Game opens' };
const input = (value: unknown) => Readable.from([JSON.stringify(value)]);
const env = () => ({ ARTEL_TOKEN: 'artel_test_token', ARTEL_API_BASE_URL: api.baseUrl });
afterEach(async () => {
  await api?.close();
});

describe('TC 검토 상태', () => {
  it.each([undefined, true, false])('생성 옵션 %s를 보내고 검증 결과는 유지한다', async (draft) => {
    api = await startFakeCaseServer({ memberProjectIds: ['1'] });
    const sink = createMemorySink();
    await runCaseCreate({ json: true, project: '1', draft }, sink, env(), undefined, input(valid));
    expect(sink.lastJson<TestCasePayload>()).toMatchObject({
      reviewStatus: draft === false ? 'READY' : 'DRAFT',
      verificationStatus: 'DRAFT',
    });
    expect(api.requests.map((r) => r.method)).toEqual(['GET', 'POST']);
    expect(api.requests[1]?.body).toMatchObject({ draft: draft ?? true });
  });

  it.each([true, false])(
    '배열 전체에 draft %s를 적용하고 지원 확인은 한 번 한다',
    async (draft) => {
      api = await startFakeCaseServer({ memberProjectIds: ['1'] });
      const sink = createMemorySink();
      await runCaseCreate(
        { json: true, project: '1', draft },
        sink,
        env(),
        undefined,
        input([valid, valid]),
      );
      expect(
        sink.lastJson<CaseCreateBatchPayload>().results.map((r) => r.created?.reviewStatus),
      ).toEqual(draft ? ['DRAFT', 'DRAFT'] : ['READY', 'READY']);
      expect(api.requests.map((r) => r.method)).toEqual(['GET', 'POST', 'POST']);
    },
  );

  it.each([undefined, false])('지원하지 않는 서버에는 생성하지 않는다 (%s)', async (draft) => {
    api = await startFakeCaseServer({ memberProjectIds: ['1'], reviewStatusSupport: false });
    await expect(
      runCaseCreate(
        { json: true, project: '1', draft },
        createMemorySink(),
        env(),
        undefined,
        input(valid),
      ),
    ).rejects.toMatchObject({ code: 'case_review_unsupported' });
    expect(api.requests.some((r) => r.method === 'POST')).toBe(false);
  });

  it.each([{ ...valid, draft: false }, [{ ...valid }, { ...valid, reviewStatus: 'READY' }]])(
    'JSON 검토 상태는 요청 전에 거절한다',
    async (body) => {
      api = await startFakeCaseServer({ memberProjectIds: ['1'] });
      await expect(
        runCaseCreate(
          { json: true, project: '1' },
          createMemorySink(),
          env(),
          undefined,
          input(body),
        ),
      ).rejects.toMatchObject({ code: 'case_invalid_body' });
      expect(api.requests).toHaveLength(0);
    },
  );

  it('본문 수정은 초안을 유지하고 승인은 검토 상태만 바꾼다', async () => {
    api = await startFakeCaseServer({
      memberProjectIds: ['1'],
      items: [fakeTestCase({ reviewStatus: 'DRAFT' })],
    });
    const sink = createMemorySink();
    await runCaseUpdate(
      '1',
      { json: true, project: '1' },
      sink,
      env(),
      undefined,
      input({ step: 'Continue' }),
    );
    expect(sink.lastJson<TestCasePayload>().reviewStatus).toBe('DRAFT');
    await runCaseUpdate(
      '1',
      { json: true, project: '1' },
      sink,
      env(),
      undefined,
      input({ reviewStatus: 'READY' }),
    );
    expect(sink.lastJson<TestCasePayload>()).toMatchObject({
      reviewStatus: 'READY',
      verificationStatus: 'DRAFT',
      step: 'Continue',
    });
  });

  it('잘못된 reviewStatus는 수정 요청 전에 거절한다', async () => {
    api = await startFakeCaseServer({ memberProjectIds: ['1'] });
    await expect(
      runCaseUpdate(
        '1',
        { json: true, project: '1' },
        createMemorySink(),
        env(),
        undefined,
        input({ reviewStatus: 'VERIFIED' }),
      ),
    ).rejects.toMatchObject({ code: 'case_invalid_body' });
    expect(api.requests).toHaveLength(0);
  });

  it('승인을 지원하지 않는 서버에는 수정 요청을 보내지 않는다', async () => {
    api = await startFakeCaseServer({ memberProjectIds: ['1'], reviewStatusSupport: false });
    await expect(
      runCaseUpdate(
        '1',
        { json: true, project: '1' },
        createMemorySink(),
        env(),
        undefined,
        input({ reviewStatus: 'READY' }),
      ),
    ).rejects.toMatchObject({ code: 'case_review_unsupported' });
    expect(api.requests.some((r) => r.method === 'PUT')).toBe(false);
  });

  it('사람이 읽는 생성 결과에도 검토 상태를 표시한다', async () => {
    api = await startFakeCaseServer({ memberProjectIds: ['1'] });
    const sink = createMemorySink();
    await runCaseCreate({ json: false, project: '1' }, sink, env(), undefined, input(valid));
    expect(sink.stdout.join('\n')).toMatch(/review status\s+DRAFT/);
  });

  it.each([{ flags: [] }, { flags: ['--draft'] }, { flags: ['--no-draft'] }])(
    'CLI flag $flags를 전달한다',
    async ({ flags }) => {
      api = await startFakeCaseServer({ memberProjectIds: ['1'] });
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'artel-review-'));
      try {
        const file = path.join(dir, 'case.json');
        await fs.writeFile(file, JSON.stringify(valid));
        const sink = createMemorySink();
        const code = await runCli(
          ['case', 'create', '--project', '1', '--file', file, ...flags, '--json'],
          sink,
          env(),
        );
        expect(code).toBe(EXIT_OK);
        expect(sink.lastJson<TestCasePayload>().reviewStatus).toBe(
          flags.includes('--no-draft') ? 'READY' : 'DRAFT',
        );
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  );

  it('boolean flag에 값을 붙이면 생성 전에 거절한다', async () => {
    api = await startFakeCaseServer({ memberProjectIds: ['1'] });
    const code = await runCli(
      ['case', 'create', '--project', '1', '--draft=false'],
      createMemorySink(),
      env(),
    );
    expect(code).toBe(EXIT_USAGE);
    expect(api.requests).toHaveLength(0);
  });

  it('옛 조회 응답은 READY로 읽지만 생성 응답에는 명시 상태가 필요하다', async () => {
    const old = fakeTestCase();
    const { reviewStatus: ignored, ...legacy } = old;
    void ignored;
    const fetchImpl = () => Promise.resolve(new Response(JSON.stringify(legacy), { status: 200 }));
    expect((await getTestCase('http://localhost', 'token', '1', '1', fetchImpl)).reviewStatus).toBe(
      'READY',
    );
    await expect(
      createTestCase('http://localhost', 'token', '1', { ...valid, draft: true }, fetchImpl),
    ).rejects.toMatchObject({ code: 'case_review_mismatch' });
  });
});
