import { describe, expect, it } from 'vitest';

import { findNewlyRegisteredInstance } from '../src/game/registration.js';
import type { GameInstance } from '../src/http/gameInstances.js';

function instance(overrides: Partial<GameInstance> = {}): GameInstance {
  return {
    id: '1',
    projectId: '42',
    name: 'my-instance',
    platform: 'UNITY',
    connected: true,
    lastConnectedAt: '2026-09-03T00:00:01Z',
    createdAt: '2026-09-03T00:00:00Z',
    updatedAt: '2026-09-03T00:00:01Z',
    ...overrides,
  };
}

describe('findNewlyRegisteredInstance', () => {
  it('picks a brand-new connected row', () => {
    const before: GameInstance[] = [];
    const after = [instance({ id: '1' })];
    expect(findNewlyRegisteredInstance(before, after)?.id).toBe('1');
  });

  it('ignores a brand-new row that is not connected yet', () => {
    const before: GameInstance[] = [];
    const after = [instance({ id: '1', connected: false, lastConnectedAt: null })];
    expect(findNewlyRegisteredInstance(before, after)).toBeNull();
  });

  it('picks an existing row that just transitioned to connected', () => {
    const before = [instance({ id: '1', connected: false, lastConnectedAt: null })];
    const after = [instance({ id: '1', connected: true, lastConnectedAt: '2026-09-03T00:00:05Z' })];
    expect(findNewlyRegisteredInstance(before, after)?.id).toBe('1');
  });

  it('ignores a row that was already connected with the same lastConnectedAt', () => {
    const before = [
      instance({ id: '1', connected: true, lastConnectedAt: '2026-09-03T00:00:01Z' }),
    ];
    const after = [instance({ id: '1', connected: true, lastConnectedAt: '2026-09-03T00:00:01Z' })];
    expect(findNewlyRegisteredInstance(before, after)).toBeNull();
  });

  it('picks a row that re-registered with a newer lastConnectedAt', () => {
    const before = [
      instance({ id: '1', connected: true, lastConnectedAt: '2026-09-03T00:00:01Z' }),
    ];
    const after = [instance({ id: '1', connected: true, lastConnectedAt: '2026-09-03T00:00:09Z' })];
    expect(findNewlyRegisteredInstance(before, after)?.id).toBe('1');
  });

  it('picks the most recently connected of several candidates', () => {
    const before: GameInstance[] = [];
    const after = [
      instance({ id: '1', lastConnectedAt: '2026-09-03T00:00:01Z' }),
      instance({ id: '2', lastConnectedAt: '2026-09-03T00:00:09Z' }),
    ];
    expect(findNewlyRegisteredInstance(before, after)?.id).toBe('2');
  });

  it('returns null when nothing changed', () => {
    const snapshot = [instance({ id: '1' })];
    expect(findNewlyRegisteredInstance(snapshot, snapshot)).toBeNull();
  });
});
