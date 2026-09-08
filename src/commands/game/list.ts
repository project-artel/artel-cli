import { resolveGameContext } from '../../game/context.js';
import type { FetchLike } from '../../http/client.js';
import { listGameInstances } from '../../http/gameInstances.js';
import type { GameInstanceListPayload } from '../../output/contract.js';
import { writeJsonPayload, type OutputSink } from '../../output/envelope.js';

export interface GameListCommandOptions {
  json: boolean;
  project: string;
  apiUrl?: string | undefined;
}

/**
 * `qa run --instance` 에 넣을 id 를 찾는 자리.
 *
 * 지금까지 그 id 의 출처는 `game start` 가 등록 직후에 찍은 한 줄뿐이었다. 터미널을 닫았으면
 * 콘솔을 열어야 했다.
 */
export async function runGameList(
  options: GameListCommandOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: FetchLike,
): Promise<void> {
  const context = await resolveGameContext(env, options.apiUrl);
  const instances = await listGameInstances(
    context.apiBaseUrl,
    context.cliToken,
    options.project,
    fetchImpl,
  );

  const payload: GameInstanceListPayload = {
    items: instances.map((instance) => ({
      id: instance.id,
      projectId: instance.projectId,
      name: instance.name,
      platform: instance.platform,
      connected: instance.connected,
      lastConnectedAt: instance.lastConnectedAt,
      createdAt: instance.createdAt,
      updatedAt: instance.updatedAt,
    })),
  };

  if (options.json) {
    writeJsonPayload(sink, payload);
    return;
  }
  printGameInstanceList(sink, options.project, payload);
}

/**
 * `offline (last 2026-09-07T06:00:00Z)` 가 가장 긴 값이다. ISO instant 는 폭이 고정이라 이
 * 자리의 최대 길이가 정해지고, 그보다 좁게 잡으면 offline 인 줄만 열이 밀린다.
 */
const STATE_WIDTH = 35;

function printGameInstanceList(
  sink: OutputSink,
  projectId: string,
  payload: GameInstanceListPayload,
): void {
  if (payload.items.length === 0) {
    sink.out(
      `No game instances in project ${projectId}. An instance appears when a build carrying the SDK registers — run "artel game start".`,
    );
    return;
  }

  sink.out(`${String(payload.items.length)} game instance(s) in project ${projectId}.`);
  for (const item of payload.items) {
    // 붙어 있는지를 먼저 적는다. `qa run` 은 붙어 있는 instance 에만 걸리므로, 목록에서
    // 고를 때 실제로 가르는 값이 그것이다.
    const state = item.connected
      ? 'connected'
      : `offline (last ${item.lastConnectedAt ?? 'never'})`;
    sink.out(
      `  ${item.id.padStart(6)}  ${state.padEnd(STATE_WIDTH)}  ${item.platform}  ${item.name}`,
    );
  }
}
