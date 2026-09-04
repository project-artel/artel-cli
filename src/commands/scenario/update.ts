import { UsageError } from '../../errors.js';
import type { FetchLike } from '../../http/client.js';
import { getScenario, toStepInput, updateScenario } from '../../http/scenario.js';
import type { OutputSink } from '../../output/envelope.js';
import { resolveScenarioContext } from '../../scenario/context.js';
import { readFromFileOrStdin } from '../../scenario/input.js';
import { toScenarioPayload } from '../../scenario/report.js';
import { parseScenarioSteps } from '../../scenario/validate.js';
import { reportScenario } from './output.js';

export interface ScenarioUpdateCommandOptions {
  json: boolean;
  title?: string | undefined;
  description?: string | undefined;
  /** 준 적이 없으면(`undefined`) 기존 스텝을 그대로 둔다 — 표준입력을 들여다보지 않는다. */
  steps?: string | undefined;
  apiUrl?: string | undefined;
}

/**
 * `PUT` 이 본문 전체를 last-write-wins 로 덮어쓰므로, 여기서 먼저 현재 draft 를 읽고 준 필드만
 * 바꾼 전체를 다시 보낸다. `--steps` 를 주지 않으면 표준입력을 전혀 건드리지 않는다 — 그래야
 * "제목만 고친다" 가 파이프되지 않은 표준입력 앞에서 멈추지 않는다.
 */
export async function runScenarioUpdate(
  scenarioId: string,
  options: ScenarioUpdateCommandOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
  stdin: NodeJS.ReadableStream = process.stdin,
  fetchImpl?: FetchLike,
): Promise<void> {
  if (
    options.title === undefined &&
    options.description === undefined &&
    options.steps === undefined
  ) {
    throw new UsageError(
      'Nothing to update: pass --title, --description, or --steps (or some combination of them).',
    );
  }

  const context = await resolveScenarioContext(env, options.apiUrl);
  const current = await getScenario(context.apiBaseUrl, context.cliToken, scenarioId, fetchImpl);

  const steps =
    options.steps === undefined
      ? current.draft.steps.map(toStepInput)
      : parseScenarioSteps(await readFromFileOrStdin(options.steps, '--steps', stdin));

  const updated = await updateScenario(
    context.apiBaseUrl,
    context.cliToken,
    scenarioId,
    {
      title: options.title ?? current.draft.title,
      description: options.description ?? current.draft.description,
      steps,
    },
    fetchImpl,
  );

  reportScenario(sink, options.json, toScenarioPayload(updated));
}
