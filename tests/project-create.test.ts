import { afterEach, expect, it, vi } from 'vitest';

import { runCli } from '../src/run.js';
import { createMemorySink } from './helpers.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

it('creates a project with the CLI credential and returns the project ID as JSON', async () => {
  const project = {
    id: '100',
    name: 'New Game',
    genre: 'ACTION',
    description: 'A new project',
    myRole: 'OWNER',
    updatedAt: '2026-11-13T00:00:00Z',
  };
  const fetch = vi.fn().mockResolvedValue(Response.json(project, { status: 201 }));
  vi.stubGlobal('fetch', fetch);
  const sink = createMemorySink();

  const code = await runCli(
    [
      'project',
      'create',
      '--name',
      'New Game',
      '--genre',
      'action',
      '--description',
      'A new project',
      '--json',
    ],
    sink,
    { ARTEL_TOKEN: 'artel_test', ARTEL_API_BASE_URL: 'https://api.example.test' },
  );

  expect(code).toBe(0);
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    'https://api.example.test/api/projects',
    expect.objectContaining({
      method: 'POST',
      headers: {
        authorization: 'Bearer artel_test',
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'New Game', genre: 'ACTION', description: 'A new project' }),
    }),
  );
  expect(sink.lastJson()).toEqual(project);
});

it('rejects an unknown genre without sending a request', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const sink = createMemorySink();

  const code = await runCli(
    ['project', 'create', '--name', 'New Game', '--genre', 'invalid', '--json'],
    sink,
    {},
  );

  expect(code).toBe(2);
  expect(fetch).not.toHaveBeenCalled();
});
