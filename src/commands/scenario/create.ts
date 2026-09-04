import { CliError } from '../../errors.js';
import type { FetchLike } from '../../http/client.js';
import { createScenario, updateScenario } from '../../http/scenario.js';
import type { OutputSink } from '../../output/envelope.js';
import { resolveScenarioContext } from '../../scenario/context.js';
import { readFromFileOrStdin } from '../../scenario/input.js';
import { toScenarioPayload } from '../../scenario/report.js';
import { parseScenarioSteps } from '../../scenario/validate.js';
import { reportScenario } from './output.js';

export interface ScenarioCreateCommandOptions {
  json: boolean;
  project: string;
  title?: string | undefined;
  description?: string | undefined;
  /** `--steps` 의 파일 경로, `"-"`, 또는 미지정(표준입력). */
  steps?: string | undefined;
  apiUrl?: string | undefined;
}

/**
 * 시나리오를 만든다. 서버의 생성 endpoint 는 `projectId` 만 받으므로(빈 시나리오), 여기서
 * `POST` 로 만든 뒤 곧바로 `PUT` 으로 본문을 싣는다 — 한 명령처럼 보이지만 두 번의 왕복이다.
 *
 * 뒤의 `PUT` 이 실패하면 이미 만들어진 빈 시나리오가 서버에 남는다. 그 id 를 오류 메시지에
 * 실어, 사용자가 처음부터 다시 만들지 않고 `artel scenario update` 로 이어받게 한다.
 */
export async function runScenarioCreate(
  options: ScenarioCreateCommandOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
  stdin: NodeJS.ReadableStream = process.stdin,
  fetchImpl?: FetchLike,
): Promise<void> {
  const stepsText = await readFromFileOrStdin(options.steps, '--steps', stdin);
  const steps = parseScenarioSteps(stepsText);

  const context = await resolveScenarioContext(env, options.apiUrl);
  const created = await createScenario(
    context.apiBaseUrl,
    context.cliToken,
    options.project,
    fetchImpl,
  );

  let scenario;
  try {
    scenario = await updateScenario(
      context.apiBaseUrl,
      context.cliToken,
      created.scenarioId,
      { title: options.title ?? '', description: options.description ?? '', steps },
      fetchImpl,
    );
  } catch (error) {
    if (error instanceof CliError) {
      throw new CliError(
        error.code,
        `Created test scenario ${created.scenarioId}, but could not save its steps: ${error.message} Retry with "artel scenario update ${created.scenarioId}" instead of creating another one.`,
      );
    }
    throw error;
  }

  reportScenario(sink, options.json, toScenarioPayload(scenario));
}
