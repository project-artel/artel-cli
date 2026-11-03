import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseGuideCatalog, showGuide, SKILLS_REVISION } from '../src/guides/knowledge.js';
import { runCli } from '../src/run.js';
import { createMemorySink } from './helpers.js';

const topic = {
  id: 'artel-game-identities',
  title: 'Game identity',
  path: 'skills/artel-game-identities/SKILL.md',
  references: ['references/example.md'],
};
const catalog = { schemaVersion: 1, topics: [topic] };
afterEach(() => vi.unstubAllGlobals());

describe('guide', () => {
  it('인증 없이 고정 revision의 목록과 원문을 JSON으로 조회한다', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        calls.push(url);
        return Promise.resolve(
          new Response(
            url.endsWith('catalog.json') ? JSON.stringify(catalog) : '# Setup\nusing Artel;',
          ),
        );
      }),
    );
    const sink = createMemorySink();
    expect(await runCli(['guide', 'list', '--json'], sink, {})).toBe(0);
    expect(sink.lastJson<{ revision: string }>().revision).toBe(SKILLS_REVISION);
    expect(await runCli(['guide', 'show', topic.id, '--json'], sink, {})).toBe(0);
    expect(sink.lastJson<{ content: string }>().content).toContain('using Artel;');
    expect(calls.every((url) => url.includes(`/${SKILLS_REVISION}/`))).toBe(true);
  });

  it('목록에 있는 supporting reference만 읽는다', async () => {
    const calls: string[] = [];
    const mock: typeof fetch = vi.fn((url) => {
      calls.push(String(url));
      return Promise.resolve(
        new Response(
          String(url).endsWith('catalog.json') ? JSON.stringify(catalog) : 'reference body',
        ),
      );
    });
    expect((await showGuide(topic.id, 'references/example.md', mock)).content).toBe(
      'reference body',
    );
    expect(calls[1]).toContain('/skills/artel-game-identities/references/example.md');
    await expect(showGuide(topic.id, '../../secret', mock)).rejects.toThrow('Unknown reference');
    await expect(showGuide('unknown', undefined, mock)).rejects.toThrow('Unknown guide');
  });

  it('깨진 catalog와 path traversal을 거절한다', () => {
    expect(() =>
      parseGuideCatalog({ ...catalog, topics: [{ ...topic, path: '../secret' }] }),
    ).toThrow();
    expect(() =>
      parseGuideCatalog({
        ...catalog,
        topics: [{ ...topic, references: ['references/../secret'] }],
      }),
    ).toThrow();
    expect(() => parseGuideCatalog({ ...catalog, topics: [topic, topic] })).toThrow();
  });

  it('조회 실패를 nonzero JSON 오류로 반환한다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('unavailable', { status: 503 }))),
    );
    const sink = createMemorySink();
    expect(await runCli(['guide', 'list', '--json'], sink, {})).not.toBe(0);
    expect(sink.lastJson<{ error: { code: string } }>().error.code).toBe('network_error');
  });
});
