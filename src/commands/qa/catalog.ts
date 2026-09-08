import type { FetchLike } from '../../http/client.js';
import { listQaLabels, listQaModels, type QaModel } from '../../http/qa.js';
import type { QaLabelsPayload, QaModelPayload, QaModelsPayload } from '../../output/contract.js';
import { writeJsonPayload, type OutputSink } from '../../output/envelope.js';
import { resolveQaContext } from '../../qa/context.js';

export interface QaModelsCommandOptions {
  json: boolean;
  apiUrl?: string | undefined;
}

export interface QaLabelsCommandOptions {
  json: boolean;
  /** 생략하면 볼 수 있는 전 프로젝트다. 서버가 그렇게 동작한다. */
  project?: string | undefined;
  apiUrl?: string | undefined;
}

/**
 * `--model` 과 `--reasoning-effort` 에 무엇을 넣을 수 있는지 보는 자리.
 *
 * 두 축은 `--content-map-mode`·`--knowledge-mode` 와 달리 값 목록이 서버에 있다. CLI 가 사본을
 * 들면 서버보다 낡을 수 있어 검증은 하지 않고, 대신 물어볼 자리를 만든다.
 */
export async function runQaModels(
  options: QaModelsCommandOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: FetchLike,
): Promise<void> {
  const context = await resolveQaContext(env, options.apiUrl);
  const models = await listQaModels(context.apiBaseUrl, context.cliToken, fetchImpl);

  const payload: QaModelsPayload = { items: models.map(toModelPayload) };

  if (options.json) {
    writeJsonPayload(sink, payload);
    return;
  }
  printModels(sink, payload);
}

function toModelPayload(model: QaModel): QaModelPayload {
  return {
    id: model.id,
    label: model.label,
    provider: model.provider,
    multimodal: model.multimodal,
    reasoningKind: model.reasoning?.kind ?? null,
    reasoningEfforts: model.reasoning?.efforts ?? null,
  };
}

function printModels(sink: OutputSink, payload: QaModelsPayload): void {
  if (payload.items.length === 0) {
    sink.out('The server lists no QA models.');
    return;
  }

  sink.out(`${String(payload.items.length)} model(s) the server accepts for --model.`);
  for (const item of payload.items) {
    // effort 를 model 과 같은 줄에 둔다. `--reasoning-effort` 가 받는 값은 model 마다 다르고,
    // 두 축을 따로 고르면 서로 맞지 않는 조합을 적게 된다.
    const efforts =
      item.reasoningEfforts === null || item.reasoningEfforts.length === 0
        ? 'no reasoning efforts'
        : `--reasoning-effort ${item.reasoningEfforts.join('|')}`;
    sink.out(`  ${item.id}`);
    sink.out(`      ${item.provider}  ${efforts}`);
  }
}

/**
 * `qa diff` 선택자와 `qa run --label` 에 쓰인 이름을 보는 자리. 이 사용자에게 실제로 런이 있는
 * 이름만 온다.
 */
export async function runQaLabels(
  options: QaLabelsCommandOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: FetchLike,
): Promise<void> {
  const context = await resolveQaContext(env, options.apiUrl);
  const labels = await listQaLabels(
    context.apiBaseUrl,
    context.cliToken,
    options.project,
    fetchImpl,
  );

  const payload: QaLabelsPayload = { labels, projectId: options.project ?? null };

  if (options.json) {
    writeJsonPayload(sink, payload);
    return;
  }
  printLabels(sink, payload);
}

function printLabels(sink: OutputSink, payload: QaLabelsPayload): void {
  // 범위를 먼저 말한다. `--project` 를 빠뜨린 사람이 다른 프로젝트의 실험 이름을 보고
  // 자기 프로젝트의 것으로 읽으면 안 된다.
  const scope =
    payload.projectId === null ? 'every project you can see' : `project ${payload.projectId}`;

  if (payload.labels.length === 0) {
    sink.out(`No experiment labels in ${scope}. "artel qa run --label <name>" makes one.`);
    return;
  }

  sink.out(`${String(payload.labels.length)} experiment label(s) in ${scope}.`);
  for (const label of payload.labels) {
    sink.out(`  ${label}`);
  }
}
