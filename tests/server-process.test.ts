import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runToCompletion } from '../src/server/process.js';

describe('runToCompletion', () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir !== null) await fs.rm(dir, { recursive: true, force: true });
    dir = null;
  });

  // Windows 의 `pg_ctl start` 처럼, 띄운 process 가 stdout pipe 를 물려받아 열어 둔 채 자신은 끝난다.
  it('returns when the command exits even if a process it started keeps stdout open', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'artel-run-'));
    const script = path.join(dir, 'leaves-a-child.mjs');
    await fs.writeFile(
      script,
      [
        "import { spawn } from 'node:child_process';",
        "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'inherit', detached: true });",
        'child.unref();',
        "console.log('server started');",
        'process.exit(0);',
      ].join('\n'),
    );

    const started = Date.now();
    const result = await runToCompletion(process.execPath, [script], { env: process.env });

    expect(result.code).toBe(0);
    expect(result.output).toContain('server started');
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
