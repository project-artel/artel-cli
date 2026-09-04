import type { FetchLike } from '../../http/client.js';
import { getRunScenarios, setRunScenarios } from '../../http/testRuns.js';
import { writeJsonPayload, type OutputSink } from '../../output/envelope.js';
import { printTestRunScenarios } from '../../output/human.js';
import { resolveTestRunContext } from '../../testRuns/context.js';
import { toTestRunScenariosPayload } from '../../testRuns/report.js';

export interface RunScenariosCommandOptions {
  json: boolean;
  project: string;
  /**
   * 주면 `PUT` 으로 전체 조합을 이 순서로 교체한다. 안 주면 `GET` 으로 지금 조합만 읽는다.
   * 순서가 결과를 바꾼다 — 벤치마크의 첫 시나리오는 저장 없이 새로 설치한 상태를 가정하므로
   * 반드시 0번(맨 앞)이어야 한다.
   */
  set?: readonly string[] | undefined;
  apiUrl?: string | undefined;
}

/**
 * 런에 묶인 시나리오를 읽거나(`GET`), `--set` 을 줬으면 전체를 교체한다(`PUT`).
 *
 * **"시나리오 하나만 추가"는 이 CLI 에 없다. 의도적으로 뺐다.** 서버의 `PUT
 * /{runId}/scenarios` 는 항상 전체 교체다 — 부분 추가가 없다. CLI 가 "추가"를 흉내 내려면
 * 먼저 `GET` 으로 지금 조합을 읽고, 새 항목을 이어 붙이고, 그 결과를 다시 `PUT` 으로
 * 써야 한다. 그런데 이 read-modify-write 사이에 다른 사람(다른 CLI 세션, console 의
 * 저작 챗봇)이 같은 런의 조합을 바꾸면, 이 명령은 그 변경을 보지 못한 채 자신이 읽은
 * 옛 목록 위에 자기 항목만 얹어 덮어쓴다 — 방금 다른 곳에서 반영한 변경이 조용히
 * 사라진다. 서버는 버전이나 `If-Match` 같은 낙관적 잠금을 이 endpoint 에 두지 않으므로
 * CLI 쪽에서 이 경쟁을 막을 방법이 없다.
 *
 * 그래서 이 명령은 그 경쟁을 만들지 않는 쪽을 택한다: `--set` 은 언제나 호출자가 원하는
 * **전체 목록**을 통째로 받는다. 부분 추가를 흉내 내고 싶은 호출자는 먼저
 * `artel run scenarios <run-id> --json` 으로 지금 조합을 스스로 읽고, 자기 쪽에서 합친
 * 뒤 `--set` 으로 그 결과를 넘겨야 한다 — read-modify-write 의 책임과 그 사이의 위험을
 * 이 CLI 가 대신 지지 않고 호출자에게 그대로 남겨 둔다.
 */
export async function runScenarios(
  runId: string,
  options: RunScenariosCommandOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: FetchLike,
): Promise<void> {
  const context = await resolveTestRunContext(env, options.apiUrl);

  const scenarios =
    options.set === undefined
      ? await getRunScenarios(
          context.apiBaseUrl,
          context.cliToken,
          options.project,
          runId,
          fetchImpl,
        )
      : await setRunScenarios(
          context.apiBaseUrl,
          context.cliToken,
          options.project,
          runId,
          [...options.set],
          fetchImpl,
        );

  const payload = toTestRunScenariosPayload(scenarios);

  if (options.json) {
    writeJsonPayload(sink, payload);
    return;
  }
  printTestRunScenarios(sink, payload);
}
