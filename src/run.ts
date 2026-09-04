import os from 'node:os';

import { Command, CommanderError } from 'commander';

import { runAuthLogin } from './commands/auth/login.js';
import { runAuthLogout } from './commands/auth/logout.js';
import { runAuthStatus } from './commands/auth/status.js';
import { runCaseCreate } from './commands/case/create.js';
import { runCaseDelete } from './commands/case/delete.js';
import { runCaseList } from './commands/case/list.js';
import { runCaseShow } from './commands/case/show.js';
import { runCaseUpdate } from './commands/case/update.js';
import { runGameLogout } from './commands/game/logout.js';
import { runGameStart } from './commands/game/start.js';
import { runQaCancel } from './commands/qa/cancel.js';
import { runQaDiff } from './commands/qa/diff.js';
import { runQaRun } from './commands/qa/run.js';
import { runQaShow } from './commands/qa/show.js';
import { runQaWatch } from './commands/qa/watch.js';
import { CliError, UsageError } from './errors.js';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from './exit.js';
import { DEFAULT_SCREEN_HEIGHT, DEFAULT_SCREEN_WIDTH } from './game/launch-args.js';
import { DEFAULT_LOGOUT_TIMEOUT_MS } from './game/logout-flow.js';
import { DEFAULT_REGISTRATION_TIMEOUT_MS } from './game/start-flow.js';
import { processSink, writeErrorEnvelope, type OutputSink } from './output/envelope.js';

export { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from './exit.js';

const DEFAULT_EXPIRES_IN_DAYS = 90;

/**
 * `qa run`/`qa watch` 가 기다리는 기본 상한(초). QA 런은 몇 분에서 몇 시간이고 Agent 자신의
 * 마감은 하루라, 상한 없이 두면 무엇 하나 잘못됐을 때 CI job 이 끝나지 않는다. `0` 은 무제한이다.
 */
const DEFAULT_QA_TIMEOUT_SECONDS = 3_600;

/** `qa` 명령들이 공유하는 `--console-url` 설명. 받아만 두고 쓰지 않는 이유를 그대로 적는다. */
const QA_CONSOLE_URL_HELP =
  'console base URL; QA commands never call the console, so this is accepted and unused';

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

/** `--timeout 0` 은 "기다림에 상한을 두지 않는다" 이므로 0 을 받아들인다. */
export function parseTimeoutSeconds(value: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new UsageError(`--timeout takes a whole number of seconds, not "${value}".`);
  }
  return Number.parseInt(value, 10);
}

/** `--width`, `--height`, `--timeout` 이 공유하는 검증. */
export function parsePositiveInt(value: string, flagLabel: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new UsageError(`${flagLabel} takes a positive whole number, not "${value}".`);
  }
  const parsed = Number.parseInt(value, 10);
  if (parsed < 1) {
    throw new UsageError(`${flagLabel} must be at least 1.`);
  }
  return parsed;
}

export async function runCli(
  argv: readonly string[],
  sink: OutputSink = processSink,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let json = false;
  // 명령이 실패하지 않고도 0 이 아닌 값으로 끝날 수 있다: `qa run`/`qa watch` 는 판정을
  // exit code 로 낸다. 실패한 QA 는 CLI 의 오류가 아니므로 예외로 던지지 않는다.
  let exitCode = EXIT_OK;
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
    .option('--api-url <url>', 'orchestration API base URL; overrides ARTEL_API_BASE_URL')
    .option('--console-url <url>', 'console base URL; overrides ARTEL_CONSOLE_BASE_URL')
    .action(
      async (options: {
        json: boolean;
        name: string;
        expiresInDays: string;
        apiUrl?: string | undefined;
        consoleUrl?: string | undefined;
      }) => {
        json = options.json;
        await runAuthLogin(
          {
            json: options.json,
            name: options.name,
            expiresInDays: parseExpiresInDays(options.expiresInDays),
            apiUrl: options.apiUrl,
            consoleUrl: options.consoleUrl,
          },
          sink,
          env,
        );
      },
    );

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

  const game = program.command('game').description('Launch a game build that is already signed in');

  game
    .command('start')
    .description('Launch a build, obtain an SDK token for it, and wait for it to register')
    .requiredOption('--project <id>', 'project the game instance registers under')
    .requiredOption('--build <path>', 'path to the game executable')
    .option('--width <n>', 'window width in pixels', String(DEFAULT_SCREEN_WIDTH))
    .option('--height <n>', 'window height in pixels', String(DEFAULT_SCREEN_HEIGHT))
    .option(
      '--timeout <seconds>',
      'seconds to wait for the game to register',
      String(DEFAULT_REGISTRATION_TIMEOUT_MS / 1_000),
    )
    .option('--json', 'emit the machine-readable result instead of human output', false)
    .option('--api-url <url>', 'orchestration API base URL; overrides ARTEL_API_BASE_URL')
    .option('--console-url <url>', 'console base URL; overrides ARTEL_CONSOLE_BASE_URL')
    .action(
      async (options: {
        project: string;
        build: string;
        width: string;
        height: string;
        timeout: string;
        json: boolean;
        apiUrl?: string | undefined;
        consoleUrl?: string | undefined;
      }) => {
        json = options.json;
        await runGameStart(
          {
            json: options.json,
            project: options.project,
            build: options.build,
            width: parsePositiveInt(options.width, '--width'),
            height: parsePositiveInt(options.height, '--height'),
            timeoutSeconds: parsePositiveInt(options.timeout, '--timeout'),
            apiUrl: options.apiUrl,
            consoleUrl: options.consoleUrl,
          },
          sink,
          env,
        );
      },
    );

  game
    .command('logout')
    .description("Clear the game's stored session by launching it briefly with -artel-logout")
    .requiredOption('--project <id>', 'project the game instance registers under')
    .requiredOption('--build <path>', 'path to the game executable')
    .option('--width <n>', 'window width in pixels', String(DEFAULT_SCREEN_WIDTH))
    .option('--height <n>', 'window height in pixels', String(DEFAULT_SCREEN_HEIGHT))
    .option(
      '--timeout <seconds>',
      'seconds to wait for the game to exit',
      String(DEFAULT_LOGOUT_TIMEOUT_MS / 1_000),
    )
    .option('--json', 'emit the machine-readable result instead of human output', false)
    .option('--api-url <url>', 'orchestration API base URL; overrides ARTEL_API_BASE_URL')
    .option('--console-url <url>', 'console base URL; overrides ARTEL_CONSOLE_BASE_URL')
    .action(
      async (options: {
        project: string;
        build: string;
        width: string;
        height: string;
        timeout: string;
        json: boolean;
        apiUrl?: string | undefined;
        consoleUrl?: string | undefined;
      }) => {
        json = options.json;
        await runGameLogout(
          {
            json: options.json,
            project: options.project,
            build: options.build,
            width: parsePositiveInt(options.width, '--width'),
            height: parsePositiveInt(options.height, '--height'),
            timeoutSeconds: parsePositiveInt(options.timeout, '--timeout'),
            apiUrl: options.apiUrl,
            consoleUrl: options.consoleUrl,
          },
          sink,
          env,
        );
      },
    );

  const qa = program
    .command('qa')
    .description('Start a QA run, watch it, read its verdict, and compare two configurations');

  qa.command('run')
    .description(
      "Start a QA run for a test run on a game instance and watch it to the agent's verdict",
    )
    .requiredOption('--test-run <id>', 'test run whose scenarios the agent executes')
    .requiredOption('--instance <id>', 'game instance the agent drives')
    .option('--model <id>', 'pin the model this run uses')
    .option('--prompt-version <version>', 'pin the prompt version this run uses')
    .option('--reasoning-effort <effort>', 'pin the reasoning effort this run uses')
    .option('--reasoning-max-tokens <n>', 'pin the reasoning token budget this run uses')
    .option(
      '--arch <json>',
      "pin the agent's structure: a JSON object, or @path naming a file that holds one",
    )
    .option('--force', 'end the QA run already on that game instance and take it over', false)
    .option('--no-wait', 'start the run and exit instead of watching it to the end')
    .option(
      '--timeout <seconds>',
      'seconds to keep watching; 0 waits with no limit',
      String(DEFAULT_QA_TIMEOUT_SECONDS),
    )
    .option('--json', 'emit the machine-readable result instead of human output', false)
    .option('--api-url <url>', 'orchestration API base URL; overrides ARTEL_API_BASE_URL')
    .option('--console-url <url>', QA_CONSOLE_URL_HELP)
    .action(
      async (options: {
        testRun: string;
        instance: string;
        model?: string | undefined;
        promptVersion?: string | undefined;
        reasoningEffort?: string | undefined;
        reasoningMaxTokens?: string | undefined;
        arch?: string | undefined;
        force: boolean;
        wait: boolean;
        timeout: string;
        json: boolean;
        apiUrl?: string | undefined;
      }) => {
        json = options.json;
        exitCode = await runQaRun(
          {
            json: options.json,
            testRun: options.testRun,
            instance: options.instance,
            model: options.model,
            promptVersion: options.promptVersion,
            reasoningEffort: options.reasoningEffort,
            reasoningMaxTokens:
              options.reasoningMaxTokens === undefined
                ? undefined
                : parsePositiveInt(options.reasoningMaxTokens, '--reasoning-max-tokens'),
            arch: options.arch,
            force: options.force,
            wait: options.wait,
            timeoutSeconds: parseTimeoutSeconds(options.timeout),
            apiUrl: options.apiUrl,
          },
          sink,
          env,
        );
      },
    );

  qa.command('watch')
    .description('Attach to a QA run that is already going and follow it to the end')
    .argument('<run-id>', 'QA run to follow')
    .option(
      '--timeout <seconds>',
      'seconds to keep watching; 0 waits with no limit',
      String(DEFAULT_QA_TIMEOUT_SECONDS),
    )
    .option('--json', 'emit the machine-readable result instead of human output', false)
    .option('--api-url <url>', 'orchestration API base URL; overrides ARTEL_API_BASE_URL')
    .option('--console-url <url>', QA_CONSOLE_URL_HELP)
    .action(
      async (
        runId: string,
        options: { timeout: string; json: boolean; apiUrl?: string | undefined },
      ) => {
        json = options.json;
        exitCode = await runQaWatch(
          runId,
          {
            json: options.json,
            timeoutSeconds: parseTimeoutSeconds(options.timeout),
            apiUrl: options.apiUrl,
          },
          sink,
          env,
        );
      },
    );

  qa.command('show')
    .description("Print a QA run's verdict, its per-step results, and the issues it reported")
    .argument('<run-id>', 'QA run to read')
    .option('--json', 'emit the machine-readable result instead of human output', false)
    .option('--api-url <url>', 'orchestration API base URL; overrides ARTEL_API_BASE_URL')
    .option('--console-url <url>', QA_CONSOLE_URL_HELP)
    .action(async (runId: string, options: { json: boolean; apiUrl?: string | undefined }) => {
      json = options.json;
      await runQaShow(runId, { json: options.json, apiUrl: options.apiUrl }, sink, env);
    });

  qa.command('cancel')
    .description('Stop a QA run that is still going, freeing its game instance')
    .argument('<run-id>', 'QA run to stop')
    .option('--json', 'emit the machine-readable result instead of human output', false)
    .option('--api-url <url>', 'orchestration API base URL; overrides ARTEL_API_BASE_URL')
    .option('--console-url <url>', QA_CONSOLE_URL_HELP)
    .action(async (runId: string, options: { json: boolean; apiUrl?: string | undefined }) => {
      json = options.json;
      await runQaCancel(runId, { json: options.json, apiUrl: options.apiUrl }, sink, env);
    });

  qa.command('diff')
    .description('Put two run configurations side by side and print the difference between them')
    .argument(
      '<base>',
      'base configuration: comma-separated key=value over model, reasoningEffort, promptVersion, agentArch',
    )
    .argument('<target>', 'configuration to compare against the base, written the same way')
    .option('--project <id>', 'project to aggregate; omit to sum every project you can see')
    .option('--from <instant>', 'ISO-8601 instant to count from; defaults to 30 days ago')
    .option('--to <instant>', 'ISO-8601 instant to count to; defaults to now')
    .option('--json', 'emit the machine-readable result instead of human output', false)
    .option('--api-url <url>', 'orchestration API base URL; overrides ARTEL_API_BASE_URL')
    .option('--console-url <url>', QA_CONSOLE_URL_HELP)
    .action(
      async (
        base: string,
        target: string,
        options: {
          project?: string | undefined;
          from?: string | undefined;
          to?: string | undefined;
          json: boolean;
          apiUrl?: string | undefined;
        },
      ) => {
        json = options.json;
        await runQaDiff(
          base,
          target,
          {
            json: options.json,
            project: options.project,
            from: options.from,
            to: options.to,
            apiUrl: options.apiUrl,
          },
          sink,
          env,
        );
      },
    );

  const caseGroup = program
    .command('case')
    .description("Create, read, update, and delete a project's reusable test cases");

  caseGroup
    .command('list')
    .description("List a project's test cases")
    .requiredOption('--project <id>', 'project whose test cases to list')
    .option('--json', 'emit the machine-readable result instead of human output', false)
    .option('--api-url <url>', 'orchestration API base URL; overrides ARTEL_API_BASE_URL')
    .action(async (options: { project: string; json: boolean; apiUrl?: string | undefined }) => {
      json = options.json;
      await runCaseList(
        { json: options.json, project: options.project, apiUrl: options.apiUrl },
        sink,
        env,
      );
    });

  caseGroup
    .command('show')
    .description('Print one test case')
    .argument('<case-id>', 'test case to read')
    .requiredOption('--project <id>', 'project the test case belongs to')
    .option('--json', 'emit the machine-readable result instead of human output', false)
    .option('--api-url <url>', 'orchestration API base URL; overrides ARTEL_API_BASE_URL')
    .action(
      async (
        caseId: string,
        options: { project: string; json: boolean; apiUrl?: string | undefined },
      ) => {
        json = options.json;
        await runCaseShow(
          caseId,
          { json: options.json, project: options.project, apiUrl: options.apiUrl },
          sink,
          env,
        );
      },
    );

  caseGroup
    .command('create')
    .description(
      'Create one test case, or many at once, from a JSON body read from --file or standard input',
    )
    .requiredOption('--project <id>', 'project to create the test case(s) in')
    .option(
      '--file <path>',
      'path to a JSON test case object, or a JSON array of them; omit to read standard input',
    )
    .option('--json', 'emit the machine-readable result instead of human output', false)
    .option('--api-url <url>', 'orchestration API base URL; overrides ARTEL_API_BASE_URL')
    .action(
      async (options: {
        project: string;
        file?: string | undefined;
        json: boolean;
        apiUrl?: string | undefined;
      }) => {
        json = options.json;
        exitCode = await runCaseCreate(
          {
            json: options.json,
            project: options.project,
            file: options.file,
            apiUrl: options.apiUrl,
          },
          sink,
          env,
        );
      },
    );

  caseGroup
    .command('update')
    .description('Update one test case from a JSON body read from --file or standard input')
    .argument('<case-id>', 'test case to update')
    .requiredOption('--project <id>', 'project the test case belongs to')
    .option(
      '--file <path>',
      'path to a JSON object holding the fields to change; omit to read standard input',
    )
    .option('--json', 'emit the machine-readable result instead of human output', false)
    .option('--api-url <url>', 'orchestration API base URL; overrides ARTEL_API_BASE_URL')
    .action(
      async (
        caseId: string,
        options: {
          project: string;
          file?: string | undefined;
          json: boolean;
          apiUrl?: string | undefined;
        },
      ) => {
        json = options.json;
        await runCaseUpdate(
          caseId,
          {
            json: options.json,
            project: options.project,
            file: options.file,
            apiUrl: options.apiUrl,
          },
          sink,
          env,
        );
      },
    );

  caseGroup
    .command('delete')
    .description('Delete one test case')
    .argument('<case-id>', 'test case to delete')
    .requiredOption('--project <id>', 'project the test case belongs to')
    .option('--json', 'emit the machine-readable result instead of human output', false)
    .option('--api-url <url>', 'orchestration API base URL; overrides ARTEL_API_BASE_URL')
    .action(
      async (
        caseId: string,
        options: { project: string; json: boolean; apiUrl?: string | undefined },
      ) => {
        json = options.json;
        await runCaseDelete(
          caseId,
          { json: options.json, project: options.project, apiUrl: options.apiUrl },
          sink,
          env,
        );
      },
    );

  try {
    await program.parseAsync(argv, { from: 'user' });
    return exitCode;
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
