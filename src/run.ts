import os from 'node:os';

import { Command, CommanderError } from 'commander';

import { runAuthLogin } from './commands/auth/login.js';
import { runAuthLogout } from './commands/auth/logout.js';
import { runAuthStatus } from './commands/auth/status.js';
import { CliError, UsageError } from './errors.js';
import { processSink, writeErrorEnvelope, type OutputSink } from './output/envelope.js';

/**
 * exit code 는 셋뿐이다: 0 성공, 1 실패, 2 사용법 오류. 더 세분한 값은 만들지 않는다 —
 * 기계가 원하는 구분은 `error.code` 가 이미 준다.
 */
export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

const DEFAULT_EXPIRES_IN_DAYS = 90;

export function defaultTokenName(hostname: string = os.hostname()): string {
  return `artel-cli@${hostname}`;
}

/** `<n>` 또는 `never`. `never` 는 만료 없음이고 서버에 `null` 로 나간다. */
export function parseExpiresInDays(value: string): number | null {
  if (value === 'never') {
    return null;
  }
  if (!/^[0-9]+$/.test(value)) {
    throw new UsageError(
      `--expires-in-days takes a whole number of days or "never", not "${value}".`,
    );
  }
  const days = Number.parseInt(value, 10);
  if (days < 1) {
    throw new UsageError('--expires-in-days must be at least 1, or "never".');
  }
  return days;
}

export async function runCli(
  argv: readonly string[],
  sink: OutputSink = processSink,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let json = false;
  const program = new Command();

  program
    .name('artel')
    .description('The command line interface for the ARTEL platform')
    .exitOverride()
    .configureOutput({
      writeOut: (text) => {
        sink.out(text.replace(/\n$/, ''));
      },
      writeErr: (text) => {
        sink.err(text.replace(/\n$/, ''));
      },
    });

  const auth = program.command('auth').description('Manage the credential this machine uses');

  auth
    .command('login')
    .description('Sign in through the console and store a CLI token on this machine')
    .option('--json', 'emit the machine-readable result instead of human output', false)
    .option('--name <name>', 'name recorded for the token in the console', defaultTokenName())
    .option(
      '--expires-in-days <days>',
      'days until the token expires, or "never"',
      String(DEFAULT_EXPIRES_IN_DAYS),
    )
    .action(async (options: { json: boolean; name: string; expiresInDays: string }) => {
      json = options.json;
      await runAuthLogin(
        {
          json: options.json,
          name: options.name,
          expiresInDays: parseExpiresInDays(options.expiresInDays),
        },
        sink,
        env,
      );
    });

  auth
    .command('status')
    .description('Report which credential this machine would use, without printing it')
    .option('--json', 'emit the machine-readable result instead of human output', false)
    .action(async (options: { json: boolean }) => {
      json = options.json;
      await runAuthStatus(options, sink, env);
    });

  auth
    .command('logout')
    .description('Remove the stored credential from this machine')
    .option('--json', 'emit the machine-readable result instead of human output', false)
    .action(async (options: { json: boolean }) => {
      json = options.json;
      await runAuthLogout(options, sink, env);
    });

  try {
    await program.parseAsync(argv, { from: 'user' });
    return EXIT_OK;
  } catch (error) {
    return report(error, json, sink);
  }
}

function report(error: unknown, json: boolean, sink: OutputSink): number {
  if (error instanceof CommanderError) {
    // `--help` 와 `--version` 도 여기로 온다. 그 둘은 실패가 아니다.
    return error.exitCode === 0 ? EXIT_OK : EXIT_USAGE;
  }

  if (error instanceof UsageError) {
    sink.err(error.message);
    return EXIT_USAGE;
  }

  if (error instanceof CliError) {
    if (json) {
      writeErrorEnvelope(sink, error.code, error.message);
    } else {
      sink.err(error.message);
    }
    return EXIT_FAILURE;
  }

  const message = error instanceof Error ? error.message : 'unknown error';
  if (json) {
    writeErrorEnvelope(sink, 'internal_error', message);
  } else {
    sink.err(message);
  }
  return EXIT_FAILURE;
}
