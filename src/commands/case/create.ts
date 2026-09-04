import { parseCaseBody, readCaseBody } from '../../case/body.js';
import { resolveCaseContext } from '../../case/context.js';
import { toTestCasePayload } from '../../case/report.js';
import { toCreateRequest } from '../../case/requests.js';
import { CliError } from '../../errors.js';
import { EXIT_FAILURE, EXIT_OK } from '../../exit.js';
import type { FetchLike } from '../../http/client.js';
import { createTestCase } from '../../http/testcase.js';
import type { CaseCreateBatchPayload, CaseCreateResultPayload } from '../../output/contract.js';
import type { OutputSink } from '../../output/envelope.js';
import { reportCaseCreateBatch, reportTestCase } from './output.js';

export interface CaseCreateCommandOptions {
  json: boolean;
  project: string;
  /** `--file`. 없으면 표준입력을 읽는다. */
  file?: string | undefined;
  apiUrl?: string | undefined;
}

/**
 * body 가 객체 하나면 케이스 하나를 만들고, 배열이면 그 개수만큼 만든다.
 *
 * 서버에 일괄 생성 endpoint 가 없다(`TestCaseController` 에는 `POST` 단건뿐이다) — 그래서
 * 배열은 CLI 가 항목마다 따로 요청한다. 여기서 반드시 지키는 것은 **하나가 막혀도 멈추지
 * 않는다**는 것이다: 벤치마크 자료처럼 수십 건을 한 번에 넣을 때, 앞쪽 한 항목이 형식이
 * 틀렸다고 뒤쪽 서른 건까지 못 만들 이유가 없다. 대신 무엇이 됐고 무엇이 안 됐는지를
 * [CaseCreateBatchPayload] 에 항목별로 남기고, 하나라도 실패하면 exit code 로 그것을 알린다.
 */
export async function runCaseCreate(
  options: CaseCreateCommandOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: FetchLike,
  stdin?: NodeJS.ReadableStream,
): Promise<number> {
  const context = await resolveCaseContext(env, options.apiUrl);
  const text = await readCaseBody(options.file, stdin);
  const body = parseCaseBody(text, options.file);

  if (Array.isArray(body)) {
    return await createMany(context, options, body, sink, fetchImpl);
  }

  const request = toCreateRequest(body, 'body');
  const created = await createTestCase(
    context.apiBaseUrl,
    context.cliToken,
    options.project,
    request,
    fetchImpl,
  );
  reportTestCase(sink, options.json, toTestCasePayload(created), 'Created');
  return EXIT_OK;
}

async function createMany(
  context: { apiBaseUrl: string; cliToken: string },
  options: CaseCreateCommandOptions,
  items: unknown[],
  sink: OutputSink,
  fetchImpl?: FetchLike,
): Promise<number> {
  if (items.length === 0) {
    throw new CliError(
      'case_invalid_body',
      'The body is an empty array; there is nothing to create.',
    );
  }

  const results: CaseCreateResultPayload[] = [];
  for (const [index, item] of items.entries()) {
    try {
      const request = toCreateRequest(item, `items[${String(index)}]`);
      const created = await createTestCase(
        context.apiBaseUrl,
        context.cliToken,
        options.project,
        request,
        fetchImpl,
      );
      results.push({ index, created: toTestCasePayload(created), error: null });
    } catch (error) {
      const cliError =
        error instanceof CliError
          ? error
          : new CliError(
              'internal_error',
              error instanceof Error ? error.message : 'unknown error',
            );
      results.push({
        index,
        created: null,
        error: { code: cliError.code, message: cliError.message },
      });
    }
  }

  const created = results.filter((result) => result.created !== null).length;
  const payload: CaseCreateBatchPayload = {
    projectId: options.project,
    requested: results.length,
    created,
    failed: results.length - created,
    results,
  };
  reportCaseCreateBatch(sink, options.json, payload);
  return payload.failed === 0 ? EXIT_OK : EXIT_FAILURE;
}
