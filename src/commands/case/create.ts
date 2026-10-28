import { parseCaseBody, readCaseBody } from '../../case/body.js';
import { resolveCaseContext } from '../../case/context.js';
import { toTestCasePayload } from '../../case/report.js';
import { describeMissing, missingCreateFields, toCreateRequest } from '../../case/requests.js';
import { CliError } from '../../errors.js';
import { EXIT_FAILURE, EXIT_OK } from '../../exit.js';
import type { FetchLike } from '../../http/client.js';
import { createTestCase, type TestCaseCreateRequest } from '../../http/testcase.js';
import type { CaseCreateBatchPayload, CaseCreateResultPayload } from '../../output/contract.js';
import type { OutputSink } from '../../output/envelope.js';
import { reportCaseCreateBatch, reportTestCase } from './output.js';

export interface CaseCreateCommandOptions {
  json: boolean;
  project: string;
  /** `--file`. 없으면 표준입력을 읽는다. */
  file?: string | undefined;
  /** `--folder`. body 항목에 `folderId` 가 없을 때만 채운다. 항목에 적은 값이 우선이다. */
  folder?: string | undefined;
  apiUrl?: string | undefined;
}

/**
 * body 가 객체 하나면 케이스 하나를 만들고, 배열이면 그 개수만큼 만든다.
 *
 * 서버에 일괄 생성 endpoint 가 없다(`TestCaseController` 에는 `POST` 단건뿐이다) — 그래서
 * 배열은 CLI 가 항목마다 따로 요청한다. 요청을 보내기 전에 파일 전체의 형식과 필수 필드
 * (`scene`, `step`, `expectedValue`)를 검증하고, 하나라도 틀리면 아무것도 만들지 않는다.
 * 검증을 통과한 뒤 서버가 항목을 거절하면(권한, 없는 folder 등) 나머지는 계속 만들고,
 * 무엇이 됐고 무엇이 안 됐는지를 [CaseCreateBatchPayload] 에 항목별로 남긴다. 하나라도
 * 실패하면 exit code 로 그것을 알린다.
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

  const request = withDefaultFolder(toCreateRequest(body, 'body'), options.folder);
  const missing = missingCreateFields(request);
  if (missing.length > 0) {
    throw new CliError('case_invalid_body', describeMissing('body', missing));
  }
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

function withDefaultFolder(
  request: TestCaseCreateRequest,
  folder: string | undefined,
): TestCaseCreateRequest {
  return request.folderId === undefined && folder !== undefined
    ? { ...request, folderId: folder }
    : request;
}

function validateAll(items: unknown[], folder: string | undefined): TestCaseCreateRequest[] {
  const requests: TestCaseCreateRequest[] = [];
  const problems: string[] = [];
  for (const [index, item] of items.entries()) {
    const label = `items[${String(index)}]`;
    try {
      const request = withDefaultFolder(toCreateRequest(item, label), folder);
      const missing = missingCreateFields(request);
      if (missing.length > 0) {
        problems.push(describeMissing(label, missing));
      }
      requests.push(request);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : 'unknown error');
    }
  }
  if (problems.length > 0) {
    throw new CliError(
      'case_invalid_body',
      `${String(problems.length)} of ${String(items.length)} items are invalid, so no test case was created:\n${problems.join('\n')}`,
    );
  }
  return requests;
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

  // 파일 전체를 먼저 검증한다. 앞의 몇 건만 만들어지고 나머지가 실패하면 반쯤 생성된 상태가
  // 남고, 같은 파일을 다시 넣으면 앞 건이 중복된다. 하나라도 틀리면 아무것도 만들지 않는다.
  const requests = validateAll(items, options.folder);

  const results: CaseCreateResultPayload[] = [];
  for (const [index, request] of requests.entries()) {
    try {
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
