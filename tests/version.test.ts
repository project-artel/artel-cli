import fs from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { EXIT_OK, EXIT_USAGE, runCli } from '../src/run.js';
import { readCliVersion } from '../src/version.js';
import { createMemorySink } from './helpers.js';

async function versionInManifest(): Promise<string> {
  const raw = await fs.readFile(new URL('../package.json', import.meta.url), 'utf8');
  return (JSON.parse(raw) as { version: string }).version;
}

describe('artel --version', () => {
  it('package.json 의 값을 그대로 낸다', async () => {
    const sink = createMemorySink();

    const code = await runCli(['--version'], sink, {});

    expect(code).toBe(EXIT_OK);
    expect(sink.stdout.join('\n')).toContain(await versionInManifest());
  });

  it('-V 도 같은 값을 낸다', async () => {
    const long = createMemorySink();
    const short = createMemorySink();

    await runCli(['--version'], long, {});
    await runCli(['-V'], short, {});

    expect(short.stdout).toEqual(long.stdout);
  });

  /**
   * `--version` 은 보고이지 실패가 아니다. `set -e` 스크립트가 버전을 찍어 보고 죽으면 안 된다.
   * 모르는 flag 는 여전히 usage 오류라는 것도 같이 못 박는다 — 둘 다 `CommanderError` 로 오고
   * 갈리는 자리는 `exitCode` 하나뿐이라, 한쪽만 보면 규칙이 뒤집혀도 통과한다.
   */
  it('보고는 exit 0 이고 모르는 flag 는 여전히 usage 오류다', async () => {
    expect(await runCli(['--version'], createMemorySink(), {})).toBe(EXIT_OK);
    expect(await runCli(['--nonesuch'], createMemorySink(), {})).toBe(EXIT_USAGE);
  });
});

describe('readCliVersion', () => {
  it('빌드 산출물이 아닌 소스에서도 패키지 root 를 찾는다', async () => {
    expect(readCliVersion()).toBe(await versionInManifest());
  });
});
