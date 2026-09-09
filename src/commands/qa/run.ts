
import { EXIT_OK } from '../../exit.js';
import type { FetchLike } from '../../http/client.js';
import { createQaRun } from '../../http/qa.js';
import type { OutputSink } from '../../output/envelope.js';
import { readArch } from '../../qa/arch.js';
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
  /** `--content-map-mode`. 값은 `qa/axes.ts` 가 이미 검증한 것이다. */
  contentMapMode?: string | undefined;
  /** `--knowledge-mode`. */
  knowledgeMode?: string | undefined;
  /** `--label`. 실험 묶음의 이름이고, arm 이름이 아니다. */
  label?: string | undefined;
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
 * `--content-map-mode` 와 `--knowledge-mode` 는 그 넷과 달리 Agent 에게 무엇을 **열어 줄지**를
 * 정한다. 둘을 따로 여는 것이 요점이다 — 한 스위치로 묶으면 지식이 도왔는지 지도가 도왔는지를
 * 가르는 2×2 가 성립하지 않는다.
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
      // 안 준 축은 키 자체를 싣지 않는다. 빈 문자열을 실으면 서버가 그것을 값으로 읽고
      // 400 으로 거절한다 — 기본값으로 떨어지지 않는다.
      ...(options.contentMapMode === undefined ? {} : { contentMapMode: options.contentMapMode }),
      ...(options.knowledgeMode === undefined ? {} : { knowledgeMode: options.knowledgeMode }),
      ...(options.label === undefined ? {} : { label: options.label }),
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

