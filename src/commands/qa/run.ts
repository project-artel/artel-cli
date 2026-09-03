import fs from 'node:fs/promises';

import { CliError } from '../../errors.js';
import { EXIT_OK } from '../../exit.js';
import type { FetchLike } from '../../http/client.js';
import { createQaRun } from '../../http/qa.js';
import type { OutputSink } from '../../output/envelope.js';
import { resolveQaContext } from '../../qa/context.js';
import { buildQaRunPayload } from '../../qa/report.js';
import { reportQaRun } from './output.js';
import { watchToEnd } from './watch.js';

export interface QaRunCommandOptions {
  json: boolean;
  testRun: string;
  instance: string;
  model?: string | undefined;
  promptVersion?: string | undefined;
  reasoningEffort?: string | undefined;
  reasoningMaxTokens?: number | undefined;
  /** `--arch` 의 원문. JSON object 이거나 `@경로`. */
  arch?: string | undefined;
  force: boolean;
  /** `--no-wait` 면 false. 시작만 하고 끝난다. */
  wait: boolean;
  timeoutSeconds: number;
  apiUrl?: string | undefined;
  pollIntervalMs?: number | undefined;
  reconnectDelaysMs?: readonly number[] | undefined;
}

/**
 * 런을 시작하고, 기본적으로 끝까지 지켜본 뒤 판정을 exit code 로 낸다(`watchToEnd`).
 *
 * `--model`·`--prompt-version`·`--reasoning-effort`·`--arch` 네 개가 두 런을 비교 가능하게
 * 만드는 축이고, `qa diff` 가 셀을 고르는 축과 같은 값이다. 적지 않으면 서버가 프로젝트
 * 기본값으로 고르며, 그 경우에도 무엇으로 돌았는지는 결과의 `tries[].model` 등에 남는다.
 *
 * `--no-wait` 는 판정이 아직 없으므로 exit code 0 이다. 시작한 것과 통과한 것은 다른 질문이다.
 */
export async function runQaRun(
  options: QaRunCommandOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: FetchLike,
): Promise<number> {
  const context = await resolveQaContext(env, options.apiUrl);
  const arch = await readArch(options.arch);

  const created = await createQaRun(
    context.apiBaseUrl,
    context.cliToken,
    {
      testRunId: options.testRun,
      gameInstanceId: options.instance,
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.promptVersion === undefined ? {} : { promptVersion: options.promptVersion }),
      ...(options.reasoningEffort === undefined && options.reasoningMaxTokens === undefined
        ? {}
        : {
            reasoning: {
              ...(options.reasoningEffort === undefined ? {} : { effort: options.reasoningEffort }),
              ...(options.reasoningMaxTokens === undefined
                ? {}
                : { maxTokens: options.reasoningMaxTokens }),
            },
          }),
      ...(arch === undefined ? {} : { arch }),
      force: options.force,
    },
    fetchImpl,
  );

  if (!options.wait) {
    const payload = await buildQaRunPayload(
      context.apiBaseUrl,
      context.cliToken,
      created,
      fetchImpl,
    );
    reportQaRun(sink, options.json, payload);
    return EXIT_OK;
  }

  sink.err(`Started QA run ${created.id}. Watching it.`);
  return await watchToEnd(context, created.id, options, sink, fetchImpl);
}

/**
 * `--arch` 는 Agent 의 구조 knob 묶음이고, 서버는 그것을 열어 보지 않고 그대로 Agent 에
 * 넘긴다(`CreateQaRunRequest.arch`). CLI 도 스키마를 알지 못하므로 JSON object 인지만 본다 —
 * 여기서 키를 검사하면 Agent 가 knob 을 하나 늘릴 때마다 CLI 가 그것을 막는다. 잘못된 knob
 * 은 Agent 가 422 로 거절하고, 그것은 실패한 런으로 보인다.
 */
async function readArch(raw: string | undefined): Promise<unknown> {
  if (raw === undefined) {
    return undefined;
  }
  let text = raw;
  if (raw.startsWith('@')) {
    const path = raw.slice(1);
    try {
      text = await fs.readFile(path, 'utf8');
    } catch (error) {
      throw new CliError(
        'qa_invalid_arch',
        `Could not read --arch from ${path}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CliError(
      'qa_invalid_arch',
      '--arch takes a JSON object, or "@path" naming a file that holds one.',
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CliError(
      'qa_invalid_arch',
      '--arch must be a JSON object, not an array or a scalar.',
    );
  }
  return parsed;
}
