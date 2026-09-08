import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runAuthLogin } from '../src/commands/auth/login.js';
import { runGameList } from '../src/commands/game/list.js';
import { runDocScan } from '../src/commands/doc/scan.js';
import { runDocUpload } from '../src/commands/doc/upload.js';
import { runProjectList } from '../src/commands/project/list.js';
import { runQaLabels, runQaModels } from '../src/commands/qa/catalog.js';
import { runQaList } from '../src/commands/qa/list.js';
import { enforcesFileMode, writeCredential } from '../src/credentials/store.js';
import { CREDENTIAL_FILE_VERSION } from '../src/credentials/types.js';
import type {
  ContentMapScanPayload,
  DocumentUploadPayload,
  ErrorEnvelope,
  GameInstanceListPayload,
  LoginPayload,
  LogoutPayload,
  ProjectListPayload,
  QaLabelsPayload,
  QaListPayload,
  QaModelsPayload,
  StatusPayload,
} from '../src/output/contract.js';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, runCli } from '../src/run.js';
import { startFakeDocServer, type FakeDocServer } from './doc-helpers.js';
import {
  fakeInstance,
  fakeProject,
  startFakeDiscoveryServer,
  type FakeDiscoveryServer,
} from './discovery-helpers.js';
import { listedTry, startFakeListServer, type FakeListServer } from './qa-list-helpers.js';
import { startFakeCatalogServer } from './qa-catalog-helpers.js';
import {
  callBack,
  createMemorySink,
  createTempConfig,
  relayQuery,
  startFakeOrchestration,
  type FakeOrchestration,
  type TempConfig,
} from './helpers.js';

/**
 * 세 명령의 키 집합은 첫 릴리스부터 공개 계약이다. 필드를 지우거나 이름을 바꾸면 이
 * 파일이 반드시 깨진다.
 */
const LOGIN_KEYS = [
  'apiBaseUrl',
  'authenticated',
  'createdAt',
  'credentialsPath',
  'expiresAt',
  'fingerprint',
  'mode',
  'source',
  'tokenId',
  'tokenName',
];

const STATUS_KEYS = [
  'apiBaseUrl',
  'apiBaseUrlSource',
  'authenticated',
  'cliVersion',
  'credentialsFileExists',
  'credentialsPath',
  'envVarState',
  'expiresAt',
  'fingerprint',
  'mode',
  'source',
  'tokenId',
  'tokenName',
];

const LOGOUT_KEYS = ['credentialsPath', 'removed', 'serverSideRevoked', 'tokenId'];

const PROJECT_LIST_KEYS = ['items', 'page', 'size', 'total'];
const PROJECT_KEYS = ['description', 'genre', 'id', 'myRole', 'name', 'updatedAt'];
const GAME_LIST_KEYS = ['items'];
const QA_LIST_KEYS = ['fetched', 'items', 'limit', 'statusFilter'];
const QA_MODELS_KEYS = ['items'];
const QA_MODEL_KEYS = [
  'id',
  'label',
  'multimodal',
  'provider',
  'reasoningEfforts',
  'reasoningKind',
];
const QA_LABELS_KEYS = ['labels', 'projectId'];
const QA_TRY_SUMMARY_KEYS = [
  'agentArch',
  'completedAt',
  'gameInstanceId',
  'id',
  'model',
  'promptVersion',
  'qaRunId',
  'reasoningEffort',
  'startedAt',
  'status',
  'testScenarioId',
];
const GAME_INSTANCE_KEYS = [
  'connected',
  'createdAt',
  'id',
  'lastConnectedAt',
  'name',
  'platform',
  'projectId',
  'updatedAt',
];

let temp: TempConfig;
let api: FakeOrchestration;
let observedChallenge = '';

beforeEach(async () => {
  temp = await createTempConfig();
  observedChallenge = '';
  api = await startFakeOrchestration({
    expectedCode: 'code',
    expectedChallenge: () => observedChallenge,
    token: 'artel_contract_token',
  });
});

afterEach(async () => {
  await api.close();
  await temp.cleanup();
});

describe('--json key sets', () => {
  it('login emits exactly its contracted keys', async () => {
    const sink = createMemorySink();
    await runAuthLogin(
      { json: true, name: 'artel-cli@test', expiresInDays: 90 },
      sink,
      {
        ARTEL_CONFIG_DIR: temp.configDir,
        ARTEL_API_BASE_URL: api.baseUrl,
        ARTEL_CONSOLE_BASE_URL: 'https://console.example.test',
      },
      (notify) => ({
        openBrowser: async (url) => {
          const relay = relayQuery(url);
          observedChallenge = relay.challenge;
          await callBack(relay.port, { code: 'code', state: relay.state });
        },
        fetchImpl: globalThis.fetch,
        randomBytes: crypto.randomBytes,
        notify,
        timeoutMs: 5_000,
      }),
    );

    expect(Object.keys(sink.lastJson<LoginPayload>()).sort()).toEqual(LOGIN_KEYS);
  });

  it('status emits exactly its contracted keys, signed in or not', async () => {
    const signedOut = createMemorySink();
    await runCli(['auth', 'status', '--json'], signedOut, { ARTEL_CONFIG_DIR: temp.configDir });
    expect(Object.keys(signedOut.lastJson<StatusPayload>()).sort()).toEqual(STATUS_KEYS);

    const signedIn = createMemorySink();
    await runCli(['auth', 'status', '--json'], signedIn, {
      ARTEL_CONFIG_DIR: temp.configDir,
      ARTEL_TOKEN: 'artel_env_token',
    });
    expect(Object.keys(signedIn.lastJson<StatusPayload>()).sort()).toEqual(STATUS_KEYS);
  });

  it('logout emits exactly its contracted keys', async () => {
    const sink = createMemorySink();
    await runCli(['auth', 'logout', '--json'], sink, { ARTEL_CONFIG_DIR: temp.configDir });
    expect(Object.keys(sink.lastJson<LogoutPayload>()).sort()).toEqual(LOGOUT_KEYS);
  });

  it('project list emits exactly its contracted keys', async () => {
    const discovery: FakeDiscoveryServer = await startFakeDiscoveryServer({
      projects: [fakeProject()],
    });
    try {
      const sink = createMemorySink();
      await runProjectList({ json: true, page: 0, limit: 100 }, sink, {
        ARTEL_CONFIG_DIR: temp.configDir,
        ARTEL_API_BASE_URL: discovery.baseUrl,
        ARTEL_TOKEN: 'artel_env_token',
      });

      const payload = sink.lastJson<ProjectListPayload>();
      expect(Object.keys(payload).sort()).toEqual(PROJECT_LIST_KEYS);
      expect(Object.keys(payload.items[0] ?? {}).sort()).toEqual(PROJECT_KEYS);
    } finally {
      await discovery.close();
    }
  });

  it('qa list emits exactly its contracted keys', async () => {
    const listServer: FakeListServer = await startFakeListServer([listedTry()]);
    try {
      const sink = createMemorySink();
      await runQaList({ json: true, project: '1', limit: 20 }, sink, {
        ARTEL_CONFIG_DIR: temp.configDir,
        ARTEL_API_BASE_URL: listServer.baseUrl,
        ARTEL_TOKEN: 'artel_env_token',
      });

      const payload = sink.lastJson<QaListPayload>();
      expect(Object.keys(payload).sort()).toEqual(QA_LIST_KEYS);
      expect(Object.keys(payload.items[0] ?? {}).sort()).toEqual(QA_TRY_SUMMARY_KEYS);
    } finally {
      await listServer.close();
    }
  });

  it('qa models and qa labels emit exactly their contracted keys', async () => {
    const catalog = await startFakeCatalogServer();
    try {
      const env = {
        ARTEL_CONFIG_DIR: temp.configDir,
        ARTEL_API_BASE_URL: catalog.baseUrl,
        ARTEL_TOKEN: 'artel_env_token',
      };

      const models = createMemorySink();
      await runQaModels({ json: true }, models, env);
      const modelsPayload = models.lastJson<QaModelsPayload>();
      expect(Object.keys(modelsPayload).sort()).toEqual(QA_MODELS_KEYS);
      expect(Object.keys(modelsPayload.items[0] ?? {}).sort()).toEqual(QA_MODEL_KEYS);

      const labels = createMemorySink();
      await runQaLabels({ json: true, project: '1' }, labels, env);
      expect(Object.keys(labels.lastJson<QaLabelsPayload>()).sort()).toEqual(QA_LABELS_KEYS);
    } finally {
      await catalog.close();
    }
  });

  it('game list emits exactly its contracted keys', async () => {
    const discovery: FakeDiscoveryServer = await startFakeDiscoveryServer({
      instances: [fakeInstance()],
    });
    try {
      const sink = createMemorySink();
      await runGameList({ json: true, project: '1' }, sink, {
        ARTEL_CONFIG_DIR: temp.configDir,
        ARTEL_API_BASE_URL: discovery.baseUrl,
        ARTEL_TOKEN: 'artel_env_token',
      });

      const payload = sink.lastJson<GameInstanceListPayload>();
      expect(Object.keys(payload).sort()).toEqual(GAME_LIST_KEYS);
      expect(Object.keys(payload.items[0] ?? {}).sort()).toEqual(GAME_INSTANCE_KEYS);
    } finally {
      await discovery.close();
    }
  });
});

describe('exit codes and reported values', () => {
  it('reports no credential with exit code 0', async () => {
    const sink = createMemorySink();
    const code = await runCli(['auth', 'status', '--json'], sink, {
      ARTEL_CONFIG_DIR: temp.configDir,
    });

    expect(code).toBe(EXIT_OK);
    const payload = sink.lastJson<StatusPayload>();
    expect(payload).toMatchObject({
      authenticated: false,
      source: null,
      envVarState: 'unset',
      credentialsFileExists: false,
      fingerprint: null,
    });
  });

  it('reports envVarState "empty" for a blank ARTEL_TOKEN', async () => {
    const sink = createMemorySink();
    await runCli(['auth', 'status', '--json'], sink, {
      ARTEL_CONFIG_DIR: temp.configDir,
      ARTEL_TOKEN: '',
    });
    expect(sink.lastJson<StatusPayload>().envVarState).toBe('empty');
  });

  it('says logout revoked nothing on the server', async () => {
    await writeCredential(
      {
        version: CREDENTIAL_FILE_VERSION,
        token: 'artel_stored',
        tokenId: '01JXSTORED',
        tokenName: 'artel-cli@laptop',
        createdAt: '2026-09-03T04:11:07Z',
        expiresAt: null,
        apiBaseUrl: 'https://api.example.test',
      },
      { ARTEL_CONFIG_DIR: temp.configDir },
    );

    const sink = createMemorySink();
    const code = await runCli(['auth', 'logout', '--json'], sink, {
      ARTEL_CONFIG_DIR: temp.configDir,
    });

    expect(code).toBe(EXIT_OK);
    expect(sink.lastJson<LogoutPayload>()).toMatchObject({
      removed: true,
      tokenId: '01JXSTORED',
      serverSideRevoked: false,
    });
  });

  it('removes a file it refuses to read, and still reports exit code 0', async () => {
    await writeCredential(
      {
        version: CREDENTIAL_FILE_VERSION,
        token: 'artel_stored',
        tokenId: '01JXSTORED',
        tokenName: 'artel-cli@laptop',
        createdAt: '2026-09-03T04:11:07Z',
        expiresAt: null,
        apiBaseUrl: 'https://api.example.test',
      },
      { ARTEL_CONFIG_DIR: temp.configDir },
    );
    await fs.writeFile(temp.credentialsFile, 'not json', { mode: 0o600 });

    const sink = createMemorySink();
    const code = await runCli(['auth', 'logout', '--json'], sink, {
      ARTEL_CONFIG_DIR: temp.configDir,
    });

    expect(code).toBe(EXIT_OK);
    expect(sink.lastJson<LogoutPayload>()).toMatchObject({ removed: true, tokenId: null });
  });

  it('answers a usage error with exit code 2', async () => {
    const sink = createMemorySink();
    expect(await runCli(['auth', 'nope'], sink, {})).toBe(EXIT_USAGE);
    expect(await runCli(['auth', 'login', '--expires-in-days', 'soon'], sink, {})).toBe(EXIT_USAGE);
  });

  it('answers --help with exit code 0', async () => {
    const sink = createMemorySink();
    expect(await runCli(['auth', '--help'], sink, {})).toBe(EXIT_OK);
    expect(sink.stdout.join('\n')).toContain('login');
  });

  it('refuses to log in without ARTEL_API_BASE_URL', async () => {
    const sink = createMemorySink();
    const code = await runCli(['auth', 'login', '--json'], sink, {
      ARTEL_CONFIG_DIR: temp.configDir,
    });

    expect(code).toBe(EXIT_FAILURE);
    expect(sink.lastJson<ErrorEnvelope>().error.code).toBe('missing_api_base_url');
  });

  it('still fires the loopback pairing rule when --api-url supplies a loopback host', async () => {
    // `--api-url` 이 environment variable 없이 이 명령까지 실제로 도달하는지, 그리고
    // 도달한 값이 loopback pairing 검사도 그대로 거치는지를 CLI 전체 경로로 확인한다.
    const sink = createMemorySink();
    const code = await runCli(
      ['auth', 'login', '--api-url', 'http://localhost:9', '--json'],
      sink,
      { ARTEL_CONFIG_DIR: temp.configDir },
    );

    expect(code).toBe(EXIT_FAILURE);
    expect(sink.lastJson<ErrorEnvelope>().error.code).toBe('missing_console_base_url');
  });

  it('rejects a malformed --api-url', async () => {
    const sink = createMemorySink();
    const code = await runCli(['auth', 'login', '--api-url', 'not-a-url', '--json'], sink, {
      ARTEL_CONFIG_DIR: temp.configDir,
    });

    expect(code).toBe(EXIT_FAILURE);
    expect(sink.lastJson<ErrorEnvelope>().error.code).toBe('invalid_base_url');
  });
});

describe.runIf(enforcesFileMode())('error envelope', () => {
  it('puts the envelope on stdout and nothing else, then exits 1', async () => {
    await writeCredential(
      {
        version: CREDENTIAL_FILE_VERSION,
        token: 'artel_stored',
        tokenId: '01JXSTORED',
        tokenName: 'artel-cli@laptop',
        createdAt: '2026-09-03T04:11:07Z',
        expiresAt: null,
        apiBaseUrl: 'https://api.example.test',
      },
      { ARTEL_CONFIG_DIR: temp.configDir },
    );
    await fs.chmod(temp.credentialsFile, 0o644);

    const sink = createMemorySink();
    const code = await runCli(['auth', 'status', '--json'], sink, {
      ARTEL_CONFIG_DIR: temp.configDir,
    });

    expect(code).toBe(EXIT_FAILURE);
    expect(sink.stdout).toHaveLength(1);
    const envelope = sink.lastJson<ErrorEnvelope>();
    expect(Object.keys(envelope)).toEqual(['error']);
    expect(Object.keys(envelope.error).sort()).toEqual(['code', 'message']);
    expect(envelope.error.code).toBe('credential_file_mode');
  });
});

const DOCUMENT_UPLOAD_KEYS = [
  'contentType',
  'documentId',
  'fileName',
  'parseStatus',
  'projectId',
  'sizeBytes',
  'stale',
  'uploadedAt',
  'version',
  'watched',
];

const CONTENT_MAP_SCAN_KEYS = [
  'error',
  'finishedAt',
  'gameBuildId',
  'gameInstanceId',
  'gameInstanceName',
  'ingestedDocuments',
  'projectId',
  'requestedAt',
  'state',
  'watched',
];

describe('doc --json key sets', () => {
  let docs: FakeDocServer;
  let pdfPath: string;

  beforeEach(async () => {
    docs = await startFakeDocServer();
    pdfPath = path.join(temp.root, 'plan.pdf');
    await fs.writeFile(pdfPath, '%PDF-1.7\n');
  });

  afterEach(async () => {
    await docs.close();
  });

  it('doc upload emits exactly its contracted keys', async () => {
    const sink = createMemorySink();
    await runDocUpload(
      pdfPath,
      { json: true, project: '12', watch: false, timeoutSeconds: 30 },
      sink,
      { ARTEL_TOKEN: 'artel_contract_token', ARTEL_API_BASE_URL: docs.baseUrl },
    );

    expect(Object.keys(sink.lastJson<DocumentUploadPayload>()).sort()).toEqual(
      DOCUMENT_UPLOAD_KEYS,
    );
  });

  it('doc scan emits exactly its contracted keys', async () => {
    const sink = createMemorySink();
    await runDocScan(
      { json: true, project: '12', build: '34', watch: false, timeoutSeconds: 30 },
      sink,
      {
        ARTEL_TOKEN: 'artel_contract_token',
        ARTEL_API_BASE_URL: docs.baseUrl,
      },
    );

    expect(Object.keys(sink.lastJson<ContentMapScanPayload>()).sort()).toEqual(
      CONTENT_MAP_SCAN_KEYS,
    );
  });
});
