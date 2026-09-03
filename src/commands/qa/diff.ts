import type { FetchLike } from '../../http/client.js';
import { getQaStats } from '../../http/qa.js';
import type { QaDiffPayload, QaDiffSidePayload } from '../../output/contract.js';
import { writeJsonPayload, type OutputSink } from '../../output/envelope.js';
import { printQaDiff } from '../../output/human.js';
import { resolveQaContext } from '../../qa/context.js';
import { differenceOf, matchCells, parseSelector, sumMetrics } from '../../qa/diff.js';

export interface QaDiffCommandOptions {
  json: boolean;
  project?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  apiUrl?: string | undefined;
}

/**
 * 실행 설정 두 개를 나란히 놓는다.
 *
 * `/api/qa-stats` 는 런을 `(model, reasoningEffort, promptVersion, agentArch)` 4-튜플로
 * 분할한 셀 목록을 준다. 이 명령은 그중 두 묶음을 골라 합계를 빼는 것뿐이다 — 비율을 다시
 * 계산하지 않는다. 서버가 평균 대신 합계를 내보내는 이유가 그것이기 때문이다(`QaStatsDtos.kt`):
 * 비율만 주고받으면 그것이 몇 개의 런에 얹힌 값인지가 사라지고, 잘 죽는 축일수록 위로
 * 편향된다. `--json` 이 표가 아니라 두 합계와 그 차이인 것도 같은 이유다.
 */
export async function runQaDiff(
  baseSelectorText: string,
  targetSelectorText: string,
  options: QaDiffCommandOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: FetchLike,
): Promise<void> {
  const base = parseSelector(baseSelectorText, 'the base configuration');
  const target = parseSelector(targetSelectorText, 'the target configuration');

  const context = await resolveQaContext(env, options.apiUrl);
  const stats = await getQaStats(
    context.apiBaseUrl,
    context.cliToken,
    {
      ...(options.project === undefined ? {} : { projectId: options.project }),
      ...(options.from === undefined ? {} : { from: options.from }),
      ...(options.to === undefined ? {} : { to: options.to }),
    },
    fetchImpl,
  );

  const baseCells = matchCells(stats.cells, base);
  const targetCells = matchCells(stats.cells, target);
  const baseSide: QaDiffSidePayload = {
    selector: base,
    cells: baseCells.length,
    metrics: sumMetrics(baseCells),
  };
  const targetSide: QaDiffSidePayload = {
    selector: target,
    cells: targetCells.length,
    metrics: sumMetrics(targetCells),
  };

  const payload: QaDiffPayload = {
    projectId: stats.projectId,
    from: stats.from,
    to: stats.to,
    truncated: stats.truncated,
    base: baseSide,
    target: targetSide,
    difference: differenceOf(baseSide.metrics, targetSide.metrics),
  };

  if (options.json) {
    writeJsonPayload(sink, payload);
    return;
  }
  printQaDiff(sink, payload);
}
