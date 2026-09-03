import type { GameInstance } from '../http/gameInstances.js';

/**
 * launch 전후로 project 의 game instance 목록을 두 번 불러 비교해, 이번 launch 가 등록시킨
 * 것이 무엇인지 찾는다. 생성 endpoint 가 따로 없어 등록은 새 행으로도, 기존 행의
 * 재연결로도 나타날 수 있다(`GameInstanceService` 참고) — 그래서 diff 로 판정한다:
 *
 * - `before` 에 없던 id: 이번에 처음 등록된 행이다.
 * - `before` 에 있었지만 그때는 `connected` 가 아니었던 id: 이번에 다시 붙었다.
 * - 계속 `connected` 였던 id: `lastConnectedAt` 이 더 최근이면 재등록으로 본다(같은 build 를
 *   껐다 켠 사이가 이 polling 구간에 들어온 경우).
 *
 * 후보가 여럿이면 — 같은 project 에 다른 게임이 동시에 붙는 경우 — 가장 최근에 연결된
 * 것을 고른다. 이번에 이 CLI 가 띄운 launch 일 가능성이 가장 높은 것이다.
 */
export function findNewlyRegisteredInstance(
  before: readonly GameInstance[],
  after: readonly GameInstance[],
): GameInstance | null {
  const beforeById = new Map(before.map((instance) => [instance.id, instance]));

  const candidates = after.filter((instance) => {
    if (!instance.connected) {
      return false;
    }
    const prior = beforeById.get(instance.id);
    if (prior === undefined || !prior.connected) {
      return true;
    }
    return timestampOf(instance.lastConnectedAt) > timestampOf(prior.lastConnectedAt);
  });

  if (candidates.length === 0) {
    return null;
  }
  return candidates.reduce((latest, candidate) =>
    timestampOf(candidate.lastConnectedAt) > timestampOf(latest.lastConnectedAt)
      ? candidate
      : latest,
  );
}

function timestampOf(value: string | null): number {
  return value === null ? Number.NEGATIVE_INFINITY : Date.parse(value);
}
