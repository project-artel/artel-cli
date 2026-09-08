import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runQaLabels, runQaModels } from '../src/commands/qa/catalog.js';
import { writeCredential } from '../src/credentials/store.js';
import { CREDENTIAL_FILE_VERSION } from '../src/credentials/types.js';
import type { QaLabelsPayload, QaModelsPayload } from '../src/output/contract.js';
import { EXIT_OK, runCli } from '../src/run.js';
import { createMemorySink, createTempConfig, type TempConfig } from './helpers.js';
import {
  startFakeCatalogServer,
  type FakeCatalogServer,
} from './qa-catalog-helpers.js';

let temp: TempConfig;
let server: FakeCatalogServer;

beforeEach(async () => {
  temp = await createTempConfig();
});

afterEach(async () => {
  await server.close();
  await temp.cleanup();
});

async function signIn(apiBaseUrl: string): Promise<void> {
  await writeCredential(
    {
      version: CREDENTIAL_FILE_VERSION,
      token: 'artel_stored',
      tokenId: '01JXSTORED',
      tokenName: 'artel-cli@laptop',
      createdAt: '2026-09-03T04:11:07Z',
      expiresAt: null,
      apiBaseUrl,
    },
    { ARTEL_CONFIG_DIR: temp.configDir },
  );
}

function envOf(): NodeJS.ProcessEnv {
  return { ARTEL_CONFIG_DIR: temp.configDir };
}

describe('artel qa models', () => {
  it('names the ids --model takes', async () => {
    server = await startFakeCatalogServer([]);
    await signIn(server.baseUrl);
    const sink = createMemorySink();

    await runQaModels({ json: true }, sink, envOf());

    expect(sink.lastJson<QaModelsPayload>().items.map((item) => item.id)).toEqual([
      'openai/gpt-5.6-luna',
      'anthropic/claude-haiku',
    ]);
  });

  /**
   * `--reasoning-effort` 가 받는 값은 model 마다 다르다. 두 축을 따로 고르면 서로 맞지 않는
   * 조합을 적게 되므로, 같은 자리에서 함께 보여야 한다.
   */
  it('carries the efforts each model takes', async () => {
    server = await startFakeCatalogServer([]);
    await signIn(server.baseUrl);
    const sink = createMemorySink();

    await runQaModels({ json: true }, sink, envOf());

    const items = sink.lastJson<QaModelsPayload>().items;
    expect(items[0]?.reasoningEfforts).toEqual(['low', 'medium', 'high']);
    expect(items[1]?.reasoningEfforts).toBeNull();
  });

  it('writes the efforts next to the model in the human output', async () => {
    server = await startFakeCatalogServer([]);
    await signIn(server.baseUrl);
    const sink = createMemorySink();

    await runQaModels({ json: false }, sink, envOf());

    const printed = sink.stdout.join('\n');
    expect(printed).toContain('--reasoning-effort low|medium|high');
    expect(printed).toContain('no reasoning efforts');
  });
});

describe('artel qa labels', () => {
  it('lists the labels of one project when asked for one', async () => {
    server = await startFakeCatalogServer(['2x2-local-pilot', 'prompt-v16-trial']);
    await signIn(server.baseUrl);
    const sink = createMemorySink();

    await runQaLabels({ json: true, project: '1' }, sink, envOf());

    const payload = sink.lastJson<QaLabelsPayload>();
    expect(payload.labels).toEqual(['2x2-local-pilot', 'prompt-v16-trial']);
    expect(payload.projectId).toBe('1');
    expect(server.paths[0]).toBe('/api/qa-stats/labels?projectId=1');
  });

  /**
   * 서버가 `projectId` 없이도 답한다. 그 범위를 출력이 말하지 않으면, 다른 프로젝트의 실험
   * 이름을 자기 프로젝트의 것으로 읽는다.
   */
  it('says the scope is every visible project when no project was given', async () => {
    server = await startFakeCatalogServer(['2x2-local-pilot']);
    await signIn(server.baseUrl);
    const sink = createMemorySink();

    await runQaLabels({ json: false }, sink, envOf());

    expect(sink.stdout.join('\n')).toContain('every project you can see');
    expect(server.paths[0]).toBe('/api/qa-stats/labels');
  });

  it('reports an empty list as a success and says how one is made', async () => {
    server = await startFakeCatalogServer([]);
    await signIn(server.baseUrl);
    const sink = createMemorySink();

    await runQaLabels({ json: false, project: '1' }, sink, envOf());

    expect(sink.stdout.join('\n')).toContain('artel qa run --label');
  });

  it('exits 0 through the CLI even with nothing to list', async () => {
    server = await startFakeCatalogServer([]);
    await signIn(server.baseUrl);

    expect(await runCli(['qa', 'labels'], createMemorySink(), envOf())).toBe(EXIT_OK);
  });
});
