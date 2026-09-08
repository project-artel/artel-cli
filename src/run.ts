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
import { runDocScan } from './commands/doc/scan.js';
import { runDocUpload } from './commands/doc/upload.js';
import { runGameList } from './commands/game/list.js';
import { runGameLogout } from './commands/game/logout.js';
import { runGameStart } from './commands/game/start.js';
import { runProjectList } from './commands/project/list.js';
import { runQaCancel } from './commands/qa/cancel.js';
import { runQaDiff } from './commands/qa/diff.js';
import { runQaLabels, runQaModels } from './commands/qa/catalog.js';
import { runQaList } from './commands/qa/list.js';
import { runQaMatrix } from './commands/qa/matrix.js';
import { runQaRun } from './commands/qa/run.js';
import { runQaShow } from './commands/qa/show.js';
import { runQaWatch } from './commands/qa/watch.js';
import { CliError, UsageError } from './errors.js';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from './exit.js';
import { DEFAULT_SCREEN_HEIGHT, DEFAULT_SCREEN_WIDTH } from './game/launch-args.js';
import { DEFAULT_LOGOUT_TIMEOUT_MS } from './game/logout-flow.js';
import { DEFAULT_REGISTRATION_TIMEOUT_MS } from './game/start-flow.js';
import { MAX_PROJECT_PAGE_SIZE } from './http/projects.js';
import { DEFAULT_QA_TRY_LIST_SIZE, MAX_QA_TRY_LIST_SIZE } from './http/qa.js';
import { processSink, writeErrorEnvelope, type OutputSink } from './output/envelope.js';
import { cliVersionForDisplay } from './version.js';
import {
  CONTENT_MAP_MODES,
  KNOWLEDGE_MODES,
  parseAxisList,
  parseAxisValues,
  parseLabel,
  requireAxisValue,
} from './qa/axes.js';
import { runScenarioApprove } from './commands/scenario/approve.js';
import { runScenarioCreate } from './commands/scenario/create.js';
import { runScenarioDelete } from './commands/scenario/delete.js';
import { runScenarioExpectedLabels } from './commands/scenario/expected-labels.js';
import { runScenarioList } from './commands/scenario/list.js';
import { runScenarioShow } from './commands/scenario/show.js';
import { runScenarioUpdate } from './commands/scenario/update.js';
import { runCreate } from './commands/run/create.js';
import { runDelete } from './commands/run/delete.js';
import { runList } from './commands/run/list.js';
import { runScenarios } from './commands/run/scenarios.js';
import { runShow } from './commands/run/show.js';
import { runUpdate } from './commands/run/update.js';

export { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from './exit.js';

const DEFAULT_EXPIRES_IN_DAYS = 90;

/**
 * `qa run`/`qa watch` 가 기다리는 기본 상한(초). QA 런은 몇 분에서 몇 시간이고 Agent 자신의
 * 마감은 하루라, 상한 없이 두면 무엇 하나 잘못됐을 때 CI job 이 끝나지 않는다. `0` 은 무제한이다.
 */
const DEFAULT_QA_TIMEOUT_SECONDS = 3_600;

/**
 * `doc upload --watch`/`doc scan --watch` 가 기다리는 기본 상한(초). 문서 추출은 LLM 한 번,
 * 스캔은 씬을 걸어 다니는 일이라 분 단위지 시간 단위가 아니다. `0` 은 무제한이다.
 */
const DEFAULT_DOC_TIMEOUT_SECONDS = 600;

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

/** `--page` 는 0 부터 센다. 서버의 `page` 파라미터가 0-based 라 CLI 가 그것을 바꾸지 않는다. */
function parsePageNumber(value: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new UsageError(`--page takes a whole number starting at 0, not "${value}".`);
  }
  return Number.parseInt(value, 10);
}

/** `--slot` 은 되풀이해 적는다. commander 는 값을 모으는 방법을 스스로 정하지 않는다. */
function collectSlot(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/**
 * 슬롯 경로가 서로 다른지 본다.
 *
 * 같은 경로를 두 번 적으면 `productName` 도 반드시 같으므로 두 인스턴스가 하나로 접히고
 * 세이브가 서로를 덮어쓴다. 경로가 다르면서 `productName` 이 같은 경우는 CLI 가 알 수 없다 —
 * 그것은 빌드를 만든 사람이 지켜야 하고, `--help` 가 그렇게 말한다.
 */
export function requireDistinctSlots(slots: readonly string[]): readonly string[] {
  if (slots.length === 0) {
    throw new UsageError('--slot needs at least one game executable to drive.');
  }
  const seen = new Set<string>();
  for (const slot of slots) {
    if (seen.has(slot)) {
      throw new UsageError(
        `--slot lists "${slot}" twice. Each slot needs its own build: two builds with the same productName share one PlayerPrefs store, so they fold into a single game instance and overwrite each other's saves.`,
      );
    }
    seen.add(slot);
  }
  return slots;
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
    // `-V, --version` 은 commander 의 기본 flag 다. 다른 이름을 주면 버그 보고에 버전을 붙여
    // 달라고 부탁할 때 그 명령이 다른 도구들과 달라진다.
    .version(cliVersionForDisplay())
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

  program
    .command('project')
    .description('List the projects this credential can see')
    .command('list')
    .description(
      'List the projects this credential can see, so --project has somewhere to come from',
    )
    .option('--page <n>', 'zero-based page to read', '0')
    .option(
      '--limit <n>',
      `projects per page; the server caps this at ${String(MAX_PROJECT_PAGE_SIZE)}`,
      String(MAX_PROJECT_PAGE_SIZE),
    )
    .option('--json', 'emit the machine-readable result instead of human output', false)
    .option('--api-url <url>', 'orchestration API base URL; overrides ARTEL_API_BASE_URL')
    .action(
      async (options: {
        page: string;
        limit: string;
        json: boolean;
        apiUrl?: string | undefined;
      }) => {
        json = options.json;
        const limit = parsePositiveInt(options.limit, '--limit');
        if (limit > MAX_PROJECT_PAGE_SIZE) {
          throw new UsageError(
            `--limit is ${String(limit)}, but the server caps a page at ${String(MAX_PROJECT_PAGE_SIZE)}. Read the rest with --page.`,
          );
        }
        await runProjectList(
          {
            json: options.json,
            page: parsePageNumber(options.page),
            limit,
            apiUrl: options.apiUrl,
          },
          sink,
          env,
        );
      },
    );

  const game = program.command('game').description('Launch a game build that is already signed in');

  game
    .command('list')
    .description(
      'List a project\'s game instances, so --instance has somewhere to come from besides the line "game start" printed',
    )
    .requiredOption('--project <id>', 'project whose game instances to list')
    .option('--json', 'emit the machine-readable result instead of human output', false)
    .option('--api-url <url>', 'orchestration API base URL; overrides ARTEL_API_BASE_URL')
    .action(async (options: { project: string; json: boolean; apiUrl?: string | undefined }) => {
      json = options.json;
      await runGameList(
        { json: options.json, project: options.project, apiUrl: options.apiUrl },
        sink,
        env,
      );
    });

  game
    .command('start')
    .description('Launch a build, obtain an SDK token for it, and wait for it to register')
    .requiredOption('--project <id>', 'project the game instance registers under')
    .requiredOption('--build <path>', 'path to the game executable')
    .option('--width <n>', 'window width in pixels', String(DEFAULT_SCREEN_WIDTH))
    .option('--height <n>', 'window height in pixels', String(DEFAULT_SCREEN_HEIGHT))
    .option(
      '--fullscreen',
      'launch full screen instead of windowed; two full-screen games cover each other, so running several builds side by side needs the windowed default',
      false,
    )
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
        fullscreen: boolean;
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
            fullscreen: options.fullscreen,
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
    .option('--model <id>', 'pin the model this run uses; "artel qa models" lists the ids')
    .option('--prompt-version <version>', 'pin the prompt version this run uses')
    .option(
      '--reasoning-effort <effort>',
      'pin the reasoning effort this run uses; the values depend on the model and "artel qa models" lists them',
    )
    .option('--reasoning-max-tokens <n>', 'pin the reasoning token budget this run uses')
    .option(
      '--arch <json>',
      "pin the agent's structure: a JSON object, or @path naming a file that holds one",
    )
    .option(
      '--content-map-mode <mode>',
      `how much of the content map this run may read and write: ${CONTENT_MAP_MODES.join(' | ')}; omit to let the server choose`,
    )
    .option(
      '--knowledge-mode <mode>',
      `how much of the knowledge store this run may read and write: ${KNOWLEDGE_MODES.join(' | ')}; omit to let the server choose`,
    )
    .option(
      '--label <name>',
      'name of the experiment this run belongs to. Name the experiment only — the arm is already in run_config, so writing "arm:map-only" here records the same fact twice and the two drift',
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
        contentMapMode?: string | undefined;
        knowledgeMode?: string | undefined;
        label?: string | undefined;
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
            contentMapMode:
              options.contentMapMode === undefined
                ? undefined
                : requireAxisValue(options.contentMapMode, '--content-map-mode', CONTENT_MAP_MODES),
            knowledgeMode:
              options.knowledgeMode === undefined
                ? undefined
                : requireAxisValue(options.knowledgeMode, '--knowledge-mode', KNOWLEDGE_MODES),
            label: options.label === undefined ? undefined : parseLabel(options.label),
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

  qa.command('matrix')
    .description(
      'Expand the cartesian product of the axis lists and run every combination, spread over several game builds',
    )
    .requiredOption('--project <id>', 'project the game instances register under')
    .requiredOption(
      '--test-run <ids>',
      'comma-separated test runs; one axis of the product (for example 1,2)',
    )
    .option(
      '--slot <path>',
      "path to a game executable this matrix may drive; repeat for each slot. One run at a time per slot, and the game is relaunched between runs so the next one starts from the title screen. Each slot needs its OWN build: sdk_uuid and the game's StagePosition both live in PlayerPrefs, which Windows keys by productName, so two builds sharing a productName fold into one game instance and overwrite each other's saves. This CLI builds nothing — prepare the builds and pass their paths",
      collectSlot,
      [],
    )
    .option(
      '--model <ids>',
      'comma-separated models, one axis of the product; one value pins the model across every combination. "artel qa models" lists the ids. Omit and the server picks per run — which means a default that changes mid-matrix puts two models in one table',
    )
    .option(
      '--prompt-version <versions>',
      'comma-separated prompt versions, one axis of the product; one value pins it across every combination',
    )
    .option(
      '--reasoning-effort <efforts>',
      'comma-separated reasoning efforts, one axis of the product; the values depend on the model and "artel qa models" lists them',
    )
    .option(
      '--repeat <n>',
      'runs per combination. A QA run is not deterministic, so one run per cell cannot tell an arm apart from a lucky day',
      '1',
    )
    .option(
      '--reasoning-max-tokens <n>',
      'reasoning token budget for every combination. Not an axis: it is the budget under a model and an effort, so multiplying it against those two produces combinations that do not go together',
    )
    .option(
      '--arch <json>',
      "the agent's structure for every combination: a JSON object, or @path naming a file that holds one. Not an axis: one JSON object cannot be split on commas",
    )
    .option(
      '--content-map-mode <modes>',
      `comma-separated content map modes, one axis of the product: ${CONTENT_MAP_MODES.join(' | ')}; omit to let the server choose`,
    )
    .option(
      '--knowledge-mode <modes>',
      `comma-separated knowledge modes, one axis of the product: ${KNOWLEDGE_MODES.join(' | ')}; omit to let the server choose`,
    )
    .option(
      '--label <name>',
      'name of the experiment every run in this matrix belongs to. Name the experiment only — the arm is already in run_config, so writing "arm:map-only" here records the same fact twice and the two drift',
    )
    .option('--width <n>', 'window width in pixels', String(DEFAULT_SCREEN_WIDTH))
    .option('--height <n>', 'window height in pixels', String(DEFAULT_SCREEN_HEIGHT))
    .option(
      '--launch-timeout <seconds>',
      'seconds to wait for each launched game to register',
      String(DEFAULT_REGISTRATION_TIMEOUT_MS / 1_000),
    )
    .option(
      '--timeout <seconds>',
      'seconds to keep watching each run; 0 waits with no limit',
      String(DEFAULT_QA_TIMEOUT_SECONDS),
    )
    .option('--json', 'emit the machine-readable result instead of human output', false)
    .option('--api-url <url>', 'orchestration API base URL; overrides ARTEL_API_BASE_URL')
    .option('--console-url <url>', 'console base URL; overrides ARTEL_CONSOLE_BASE_URL')
    .action(
      async (options: {
        project: string;
        testRun: string;
        slot: string[];
        model?: string | undefined;
        promptVersion?: string | undefined;
        reasoningEffort?: string | undefined;
        repeat: string;
        reasoningMaxTokens?: string | undefined;
        arch?: string | undefined;
        contentMapMode?: string | undefined;
        knowledgeMode?: string | undefined;
        label?: string | undefined;
        width: string;
        height: string;
        launchTimeout: string;
        timeout: string;
        json: boolean;
        apiUrl?: string | undefined;
        consoleUrl?: string | undefined;
      }) => {
        json = options.json;
        exitCode = await runQaMatrix(
          {
            json: options.json,
            project: options.project,
            testRunIds: parseAxisList(options.testRun, '--test-run'),
            // 축 flag 를 안 주면 그 축은 값 하나짜리이고 그 값은 "안 준 것"(null)이다.
            // 조합은 그대로 하나 생기고, body 에는 그 키가 실리지 않아 서버 기본값으로 돈다.
            //
            // 이 셋은 값 목록을 CLI 가 모른다. `--content-map-mode` 처럼 미리 거절하지 못하고
            // 서버가 아는 목록은 `artel qa models` 로 본다.
            models:
              options.model === undefined ? [null] : parseAxisList(options.model, '--model'),
            promptVersions:
              options.promptVersion === undefined
                ? [null]
                : parseAxisList(options.promptVersion, '--prompt-version'),
            reasoningEfforts:
              options.reasoningEffort === undefined
                ? [null]
                : parseAxisList(options.reasoningEffort, '--reasoning-effort'),
            repeats: parsePositiveInt(options.repeat, '--repeat'),
            // 축이 아니라 전 조합에 걸리는 고정값이다. 이유는 `--help` 에 적혀 있다.
            ...(options.reasoningMaxTokens === undefined
              ? {}
              : {
                  reasoningMaxTokens: parsePositiveInt(
                    options.reasoningMaxTokens,
                    '--reasoning-max-tokens',
                  ),
                }),
            arch: options.arch,
            contentMapModes:
              options.contentMapMode === undefined
                ? [null]
                : parseAxisValues(options.contentMapMode, '--content-map-mode', CONTENT_MAP_MODES),
            knowledgeModes:
              options.knowledgeMode === undefined
                ? [null]
                : parseAxisValues(options.knowledgeMode, '--knowledge-mode', KNOWLEDGE_MODES),
            label: options.label === undefined ? undefined : parseLabel(options.label),
            slots: requireDistinctSlots(options.slot),
            width: parsePositiveInt(options.width, '--width'),
            height: parsePositiveInt(options.height, '--height'),
            launchTimeoutSeconds: parsePositiveInt(options.launchTimeout, '--launch-timeout'),
            timeoutSeconds: parseTimeoutSeconds(options.timeout),
            apiUrl: options.apiUrl,
            consoleUrl: options.consoleUrl,
          },
          sink,
          env,
        );
      },
    );

  qa.command('models')
    .description('List the models the server accepts for --model, with the efforts each one takes')
    .option('--json', 'emit the machine-readable result instead of human output', false)
    .option('--api-url <url>', 'orchestration API base URL; overrides ARTEL_API_BASE_URL')
    .option('--console-url <url>', QA_CONSOLE_URL_HELP)
    .action(async (options: { json: boolean; apiUrl?: string | undefined }) => {
      json = options.json;
      await runQaModels({ json: options.json, apiUrl: options.apiUrl }, sink, env);
    });

  qa.command('labels')
    .description('List the experiment labels QA runs have carried, for "qa diff" and --label')
    .option(
      '--project <id>',
      'project whose labels to list; omit for every project you can see, the way the server aggregates',
    )
    .option('--json', 'emit the machine-readable result instead of human output', false)
    .option('--api-url <url>', 'orchestration API base URL; overrides ARTEL_API_BASE_URL')
    .option('--console-url <url>', QA_CONSOLE_URL_HELP)
    .action(
      async (options: { project?: string | undefined; json: boolean; apiUrl?: string | undefined }) => {
        json = options.json;
        await runQaLabels(
          { json: options.json, project: options.project, apiUrl: options.apiUrl },
          sink,
          env,
        );
      },
    );

  qa.command('list')
    .description(
      "List a project's recent QA tries, newest first, with the run id each one belongs to",
    )
    .requiredOption('--project <id>', 'project whose QA tries to list')
    .option(
      '--limit <n>',
      `tries to fetch; the server takes 1 to ${String(MAX_QA_TRY_LIST_SIZE)}`,
      String(DEFAULT_QA_TRY_LIST_SIZE),
    )
    .option(
      '--status <status>',
      'keep only tries in this status. The server has no status filter, so this narrows the tries --limit fetched rather than the whole project',
    )
    .option('--json', 'emit the machine-readable result instead of human output', false)
    .option('--api-url <url>', 'orchestration API base URL; overrides ARTEL_API_BASE_URL')
    .option('--console-url <url>', QA_CONSOLE_URL_HELP)
    .action(
      async (options: {
        project: string;
        limit: string;
        status?: string | undefined;
        json: boolean;
        apiUrl?: string | undefined;
      }) => {
        json = options.json;
        const limit = parsePositiveInt(options.limit, '--limit');
        if (limit > MAX_QA_TRY_LIST_SIZE) {
          throw new UsageError(
            `--limit is ${String(limit)}, but the server takes at most ${String(MAX_QA_TRY_LIST_SIZE)}.`,
          );
        }
        await runQaList(
          {
            json: options.json,
            project: options.project,
            limit,
            status: options.status,
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

  const scenario = program
    .command('scenario')
    .description('Author, review, and approve the scenarios a QA run executes');

  scenario
    .command('list')
    .description("List a project's test scenarios")
    .requiredOption('--project <id>', 'project whose scenarios to list')
    .option('--json', 'emit the machine-readable result instead of human output', false)
    .option('--api-url <url>', 'orchestration API base URL; overrides ARTEL_API_BASE_URL')
    .option('--console-url <url>', QA_CONSOLE_URL_HELP)
    .action(async (options: { project: string; json: boolean; apiUrl?: string | undefined }) => {
      json = options.json;
      await runScenarioList(
        { json: options.json, project: options.project, apiUrl: options.apiUrl },
        sink,
        env,
      );
    });

  scenario
    .command('create')
    .description(
      'Create a test scenario; its steps come from --steps <path> or from standard input, never from a command-line argument',
    )
    .requiredOption('--project <id>', 'project the scenario belongs to')
    .option('--title <text>', 'scenario title')
    .option('--description <text>', 'scenario description')
    .option(
      '--steps <path>',
      'path to a JSON file holding the steps array, or "-" (or omit) to read it from standard input',
    )
    .option('--json', 'emit the machine-readable result instead of human output', false)
    .option('--api-url <url>', 'orchestration API base URL; overrides ARTEL_API_BASE_URL')
    .option('--console-url <url>', QA_CONSOLE_URL_HELP)
    .action(
      async (options: {
        project: string;
        title?: string | undefined;
        description?: string | undefined;
        steps?: string | undefined;
        json: boolean;
        apiUrl?: string | undefined;
      }) => {
        json = options.json;
        await runScenarioCreate(
          {
            json: options.json,
            project: options.project,
            title: options.title,
            description: options.description,
            steps: options.steps,
            apiUrl: options.apiUrl,
          },
          sink,
          env,
        );
      },
    );

  scenario
    .command('show')
    .description("Print a test scenario's title, description, and steps")
    .argument('<scenario-id>', 'test scenario to read')
    .option('--json', 'emit the machine-readable result instead of human output', false)
    .option('--api-url <url>', 'orchestration API base URL; overrides ARTEL_API_BASE_URL')
    .option('--console-url <url>', QA_CONSOLE_URL_HELP)
    .action(async (scenarioId: string, options: { json: boolean; apiUrl?: string | undefined }) => {
      json = options.json;
      await runScenarioShow(scenarioId, { json: options.json, apiUrl: options.apiUrl }, sink, env);
    });

  scenario
    .command('update')
    .description(
      "Change a test scenario's title, description, or steps; an updated steps array comes from --steps <path> or standard input, never from a command-line argument",
    )
    .argument('<scenario-id>', 'test scenario to change')
    .option('--title <text>', 'new title')
    .option('--description <text>', 'new description')
    .option(
      '--steps <path>',
      'path to a JSON file holding the new steps array, or "-" to read it from standard input; omit to leave steps unchanged',
    )
    .option('--json', 'emit the machine-readable result instead of human output', false)
    .option('--api-url <url>', 'orchestration API base URL; overrides ARTEL_API_BASE_URL')
    .option('--console-url <url>', QA_CONSOLE_URL_HELP)
    .action(
      async (
        scenarioId: string,
        options: {
          title?: string | undefined;
          description?: string | undefined;
          steps?: string | undefined;
          json: boolean;
          apiUrl?: string | undefined;
        },
      ) => {
        json = options.json;
        await runScenarioUpdate(
          scenarioId,
          {
            json: options.json,
            title: options.title,
            description: options.description,
            steps: options.steps,
            apiUrl: options.apiUrl,
          },
          sink,
          env,
        );
      },
    );

  scenario
    .command('delete')
    .description('Delete a test scenario')
    .argument('<scenario-id>', 'test scenario to delete')
    .option(
      '--force',
      'also delete its QA run history; without this, a scenario with QA history is kept',
      false,
    )
    .option('--json', 'emit the machine-readable result instead of human output', false)
    .option('--api-url <url>', 'orchestration API base URL; overrides ARTEL_API_BASE_URL')
    .option('--console-url <url>', QA_CONSOLE_URL_HELP)
    .action(
      async (
        scenarioId: string,
        options: { force: boolean; json: boolean; apiUrl?: string | undefined },
      ) => {
        json = options.json;
        await runScenarioDelete(
          scenarioId,
          { json: options.json, force: options.force, apiUrl: options.apiUrl },
          sink,
          env,
        );
      },
    );

  scenario
    .command('approve')
    .description(
      'Approve a test scenario. This finalizes its last saved draft; it is not a permission check — the server tracks no approval state, and an unapproved scenario can already run in a QA run',
    )
    .argument('<scenario-id>', 'test scenario to approve')
    .option('--json', 'emit the machine-readable result instead of human output', false)
    .option('--api-url <url>', 'orchestration API base URL; overrides ARTEL_API_BASE_URL')
    .option('--console-url <url>', QA_CONSOLE_URL_HELP)
    .action(async (scenarioId: string, options: { json: boolean; apiUrl?: string | undefined }) => {
      json = options.json;
      await runScenarioApprove(
        scenarioId,
        { json: options.json, apiUrl: options.apiUrl },
        sink,
        env,
      );
    });

  scenario
    .command('expected-labels')
    .description(
      "Set the expected pass/fail label for the scenario's steps — the answer key that a QA run's correctPass/falseAlarm counts score against; labels come from --labels <path> or standard input, never from a command-line argument",
    )
    .argument('<scenario-id>', 'test scenario whose step labels to set')
    .option(
      '--labels <path>',
      'path to a JSON file holding the labels array, or "-" (or omit) to read it from standard input',
    )
    .option('--json', 'emit the machine-readable result instead of human output', false)
    .option('--api-url <url>', 'orchestration API base URL; overrides ARTEL_API_BASE_URL')
    .option('--console-url <url>', QA_CONSOLE_URL_HELP)
    .action(
      async (
        scenarioId: string,
        options: { labels?: string | undefined; json: boolean; apiUrl?: string | undefined },
      ) => {
        json = options.json;
        await runScenarioExpectedLabels(
          scenarioId,
          { json: options.json, labels: options.labels, apiUrl: options.apiUrl },
          sink,
          env,
        );
      },
    );

  /** `run` 명령들이 공유하는 `--console-url` 설명. 이 그룹도 console 을 부르지 않는다. */
  const RUN_CONSOLE_URL_HELP =
    'console base URL; test run commands never call the console, so this is accepted and unused';

  const run = program
    .command('run')
    .description(
      'Manage test runs — the scenario sets a QA run executes. Not "artel qa run", which starts an execution of one.',
    );

  run
    .command('list')
    .description('List the test runs in a project')
    .requiredOption('--project <id>', 'project the test runs belong to')
    .option('--json', 'emit the machine-readable result instead of human output', false)
    .option('--api-url <url>', 'orchestration API base URL; overrides ARTEL_API_BASE_URL')
    .option('--console-url <url>', RUN_CONSOLE_URL_HELP)
    .action(async (options: { project: string; json: boolean; apiUrl?: string | undefined }) => {
      json = options.json;
      await runList(
        { json: options.json, project: options.project, apiUrl: options.apiUrl },
        sink,
        env,
      );
    });

  run
    .command('create')
    .description('Create a test run, empty of scenarios until "artel run scenarios --set" fills it')
    .requiredOption('--project <id>', 'project the test run belongs to')
    .requiredOption('--name <name>', 'name for the test run')
    .option('--description <text>', 'description for the test run')
    .option('--json', 'emit the machine-readable result instead of human output', false)
    .option('--api-url <url>', 'orchestration API base URL; overrides ARTEL_API_BASE_URL')
    .option('--console-url <url>', RUN_CONSOLE_URL_HELP)
    .action(
      async (options: {
        project: string;
        name: string;
        description?: string | undefined;
        json: boolean;
        apiUrl?: string | undefined;
      }) => {
        json = options.json;
        await runCreate(
          {
            json: options.json,
            project: options.project,
            name: options.name,
            description: options.description,
            apiUrl: options.apiUrl,
          },
          sink,
          env,
        );
      },
    );

  run
    .command('show')
    .description('Print one test run')
    .argument('<run-id>', 'test run to read')
    .requiredOption('--project <id>', 'project the test run belongs to')
    .option('--json', 'emit the machine-readable result instead of human output', false)
    .option('--api-url <url>', 'orchestration API base URL; overrides ARTEL_API_BASE_URL')
    .option('--console-url <url>', RUN_CONSOLE_URL_HELP)
    .action(
      async (
        runId: string,
        options: { project: string; json: boolean; apiUrl?: string | undefined },
      ) => {
        json = options.json;
        await runShow(
          runId,
          { json: options.json, project: options.project, apiUrl: options.apiUrl },
          sink,
          env,
        );
      },
    );

  run
    .command('update')
    .description("Change a test run's name or description")
    .argument('<run-id>', 'test run to change')
    .requiredOption('--project <id>', 'project the test run belongs to')
    .option('--name <name>', 'new name for the test run')
    .option('--description <text>', 'new description for the test run')
    .option('--json', 'emit the machine-readable result instead of human output', false)
    .option('--api-url <url>', 'orchestration API base URL; overrides ARTEL_API_BASE_URL')
    .option('--console-url <url>', RUN_CONSOLE_URL_HELP)
    .action(
      async (
        runId: string,
        options: {
          project: string;
          name?: string | undefined;
          description?: string | undefined;
          json: boolean;
          apiUrl?: string | undefined;
        },
      ) => {
        json = options.json;
        await runUpdate(
          runId,
          {
            json: options.json,
            project: options.project,
            name: options.name,
            description: options.description,
            apiUrl: options.apiUrl,
          },
          sink,
          env,
        );
      },
    );

  run
    .command('delete')
    .description(
      'Delete a test run. Without --yes, only shows what would be taken down with it and deletes nothing',
    )
    .argument('<run-id>', 'test run to delete')
    .requiredOption('--project <id>', 'project the test run belongs to')
    .option(
      '--drop-scenarios',
      'also delete the scenarios that appear in no other test run (scenarios with QA history are always kept)',
      false,
    )
    .option('--yes', 'actually delete, instead of only showing the deletion preview', false)
    .option('--json', 'emit the machine-readable result instead of human output', false)
    .option('--api-url <url>', 'orchestration API base URL; overrides ARTEL_API_BASE_URL')
    .option('--console-url <url>', RUN_CONSOLE_URL_HELP)
    .action(
      async (
        runId: string,
        options: {
          project: string;
          dropScenarios: boolean;
          yes: boolean;
          json: boolean;
          apiUrl?: string | undefined;
        },
      ) => {
        json = options.json;
        await runDelete(
          runId,
          {
            json: options.json,
            project: options.project,
            dropScenarios: options.dropScenarios,
            yes: options.yes,
            apiUrl: options.apiUrl,
          },
          sink,
          env,
        );
      },
    );

  run
    .command('scenarios')
    .description(
      'Show the scenarios bound to a test run, in run order; with --set, replace the whole binding',
    )
    .argument('<run-id>', 'test run whose scenario binding to read or replace')
    .requiredOption('--project <id>', 'project the test run belongs to')
    .option(
      '--set <ids>',
      'replace the whole binding with these scenario ids, comma-separated and in run order (the first must be the save-less fresh-install scenario)',
    )
    .option('--json', 'emit the machine-readable result instead of human output', false)
    .option('--api-url <url>', 'orchestration API base URL; overrides ARTEL_API_BASE_URL')
    .option('--console-url <url>', RUN_CONSOLE_URL_HELP)
    .action(
      async (
        runId: string,
        options: {
          project: string;
          set?: string | undefined;
          json: boolean;
          apiUrl?: string | undefined;
        },
      ) => {
        json = options.json;
        await runScenarios(
          runId,
          {
            json: options.json,
            project: options.project,
            set: parseScenarioIds(options.set),
            apiUrl: options.apiUrl,
          },
          sink,
          env,
        );
      },
    );

  const DOC_CONSOLE_URL_HELP =
    'console base URL; doc commands never call the console, so this is accepted and unused';

  const doc = program
    .command('doc')
    .description(
      'Upload a project document, and tell a running game to scan itself for `evidence`',
    );

  doc
    .command('upload')
    .description(
      'Upload a PDF project document. The bytes go straight to storage, never through the orchestration server; extraction into `knowledge` starts once the server registers the version',
    )
    .argument('<file>', 'PDF file to upload')
    .requiredOption('--project <id>', 'project the document belongs to')
    .option(
      '--watch',
      'follow the extraction until parse status reaches EXTRACTED or FAILED, instead of exiting right after registration',
      false,
    )
    .option(
      '--timeout <seconds>',
      'how long --watch waits before giving up; 0 waits forever',
      String(DEFAULT_DOC_TIMEOUT_SECONDS),
    )
    .option('--json', 'emit the machine-readable result instead of human output', false)
    .option('--api-url <url>', 'orchestration API base URL; overrides ARTEL_API_BASE_URL')
    .option('--console-url <url>', DOC_CONSOLE_URL_HELP)
    .action(
      async (
        file: string,
        options: {
          project: string;
          watch: boolean;
          timeout: string;
          json: boolean;
          apiUrl?: string | undefined;
        },
      ) => {
        json = options.json;
        exitCode = await runDocUpload(
          file,
          {
            json: options.json,
            project: options.project,
            watch: options.watch,
            timeoutSeconds: parseTimeoutSeconds(options.timeout),
            apiUrl: options.apiUrl,
          },
          sink,
          env,
        );
      },
    );

  doc
    .command('scan')
    .description(
      'Tell the game that is running this build to scan itself and upload an `evidence` document. The command is sent, not finished: it answers as soon as the running game has the order',
    )
    .requiredOption('--project <id>', 'project the game build belongs to')
    .requiredOption('--build <id>', 'game build to scan')
    .option(
      '--watch',
      'follow the scan until it reaches SUCCEEDED or FAILED, instead of exiting once the order is sent',
      false,
    )
    .option(
      '--timeout <seconds>',
      'how long --watch waits before giving up; 0 waits forever',
      String(DEFAULT_DOC_TIMEOUT_SECONDS),
    )
    .option('--json', 'emit the machine-readable result instead of human output', false)
    .option('--api-url <url>', 'orchestration API base URL; overrides ARTEL_API_BASE_URL')
    .option('--console-url <url>', DOC_CONSOLE_URL_HELP)
    .action(
      async (options: {
        project: string;
        build: string;
        watch: boolean;
        timeout: string;
        json: boolean;
        apiUrl?: string | undefined;
      }) => {
        json = options.json;
        exitCode = await runDocScan(
          {
            json: options.json,
            project: options.project,
            build: options.build,
            watch: options.watch,
            timeoutSeconds: parseTimeoutSeconds(options.timeout),
            apiUrl: options.apiUrl,
          },
          sink,
          env,
        );
      },
    );

  /** `--set` 의 원문을 콤마로 가른다. 빈 문자열 항목은 실수(연달아 찍은 콤마 등)로 보고 버린다. */
  function parseScenarioIds(raw: string | undefined): readonly string[] | undefined {
    if (raw === undefined) {
      return undefined;
    }
    return raw
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
  }

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
