import type { FetchLike } from '../../http/client.js';
import { updateExpectedLabels } from '../../http/scenario.js';
import type { OutputSink } from '../../output/envelope.js';
import { resolveScenarioContext } from '../../scenario/context.js';
import { readFromFileOrStdin } from '../../scenario/input.js';
import { toScenarioPayload } from '../../scenario/report.js';
import { parseExpectedLabelEntries } from '../../scenario/validate.js';
import { reportScenario } from './output.js';

export interface ScenarioExpectedLabelsCommandOptions {
  json: boolean;
  /** `--labels` 의 파일 경로, `"-"`, 또는 미지정(표준입력). */
  labels?: string | undefined;
  apiUrl?: string | undefined;
}

/**
 * 스텝의 기대 판정(정답지)만 갈아끼운다 — 본문은 건드리지 않는다. QA 에이전트의 스텝 판정은
 * 자기채점이라, 이 라벨과 대조하지 않으면 관대한 모델이 "전부 통과" 라고 답하는 전략이
 * 만점이 된다(`ExpectedLabelPolicy` 의 규율). 서버의 `correctPass`·`falseAlarm` 집계가
 * 대조하는 답이 바로 이 값이다.
 */
export async function runScenarioExpectedLabels(
  scenarioId: string,
  options: ScenarioExpectedLabelsCommandOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
  stdin: NodeJS.ReadableStream = process.stdin,
  fetchImpl?: FetchLike,
): Promise<void> {
  const labelsText = await readFromFileOrStdin(options.labels, '--labels', stdin);
  const labels = parseExpectedLabelEntries(labelsText);

  const context = await resolveScenarioContext(env, options.apiUrl);
  const scenario = await updateExpectedLabels(
    context.apiBaseUrl,
    context.cliToken,
    scenarioId,
    labels,
    fetchImpl,
  );

  reportScenario(sink, options.json, toScenarioPayload(scenario));
}
