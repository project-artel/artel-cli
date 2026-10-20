import fs from 'node:fs/promises';
import path from 'node:path';

import { SupervisorError } from './errors.js';
import { RUNTIME_TARGETS, type RuntimeTarget } from './paths.js';

export const MANIFEST_SCHEMA_VERSION = 1;

export const EXECUTABLE_NAMES = [
  'postgres',
  'initdb',
  'pg_ctl',
  'pg_isready',
  'createdb',
  'java',
  'python',
] as const;

export type ExecutableName = (typeof EXECUTABLE_NAMES)[number];

/** runtime bundle 의 `manifest.json`. 경로는 모두 runtime 디렉터리 기준 상대 경로이고 `/` 로 나눈다. */
export interface RuntimeManifest {
  schemaVersion: 1;
  version: string;
  target: RuntimeTarget;
  executables: Record<ExecutableName, string>;
  orchestrationJar: string;
  agentServerDir: string;
  homeDir: string;
  components: Record<string, string>;
  sources: Record<string, string>;
}

/** manifest 의 상대 경로를 절대 경로로 바꾼 것. supervisor 는 이것만 쓴다. */
export interface RuntimeLayout {
  runtimeDir: string;
  manifest: RuntimeManifest;
  executables: Record<ExecutableName, string>;
  orchestrationJar: string;
  agentServerDir: string;
  homeDir: string;
}

function invalid(detail: string): SupervisorError {
  return new SupervisorError('server_runtime_invalid', `The runtime manifest ${detail}.`);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalid(`has no string "${field}"`);
  }
  return value;
}

/**
 * `..` 나 절대 경로가 들어오면 runtime 디렉터리 밖의 실행 파일을 돌리게 된다. manifest 는
 * 내려받은 archive 안에 있으므로 여기서 막는다.
 */
function requireRelativePath(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (text.includes('\\')) {
    throw invalid(`gives "${field}" with a backslash; paths use "/" separators`);
  }
  if (text.startsWith('/') || /^[A-Za-z]:/.test(text) || text.split('/').includes('..')) {
    throw invalid(`gives "${field}" as "${text}", which leaves the runtime directory`);
  }
  return text;
}

function requireStringRecord(value: unknown, field: string): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(`has no object "${field}"`);
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = requireString(entry, `${field}.${key}`);
  }
  return result;
}

/** 경계에서 한 번 parse 한다. 이후 코드는 `RuntimeManifest` 만 받는다. */
export function parseManifest(raw: unknown): RuntimeManifest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw invalid('is not a JSON object');
  }
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw invalid(
      `has schemaVersion ${JSON.stringify(record.schemaVersion)}; this CLI reads ${String(MANIFEST_SCHEMA_VERSION)}`,
    );
  }
  const target = requireString(record.target, 'target');
  if (!(RUNTIME_TARGETS as readonly string[]).includes(target)) {
    throw invalid(`names the unknown target "${target}"`);
  }
  const executablesRaw = record.executables;
  if (typeof executablesRaw !== 'object' || executablesRaw === null) {
    throw invalid('has no object "executables"');
  }
  const executables = {} as Record<ExecutableName, string>;
  for (const name of EXECUTABLE_NAMES) {
    executables[name] = requireRelativePath(
      (executablesRaw as Record<string, unknown>)[name],
      `executables.${name}`,
    );
  }
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    version: requireString(record.version, 'version'),
    target: target as RuntimeTarget,
    executables,
    orchestrationJar: requireRelativePath(record.orchestrationJar, 'orchestrationJar'),
    agentServerDir: requireRelativePath(record.agentServerDir, 'agentServerDir'),
    homeDir: requireRelativePath(record.homeDir, 'homeDir'),
    components:
      record.components === undefined ? {} : requireStringRecord(record.components, 'components'),
    sources: record.sources === undefined ? {} : requireStringRecord(record.sources, 'sources'),
  };
}

function absolute(runtimeDir: string, relative: string): string {
  return path.join(runtimeDir, ...relative.split('/'));
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * runtime 디렉터리를 읽고 manifest 가 가리키는 파일이 모두 있는지 본다. 하나라도 없으면 실행
 * 도중이 아니라 여기서 무엇이 없는지 말한다.
 */
export async function loadRuntime(runtimeDir: string): Promise<RuntimeLayout> {
  const manifestPath = path.join(runtimeDir, 'manifest.json');
  let text: string;
  try {
    text = await fs.readFile(manifestPath, 'utf8');
  } catch {
    throw new SupervisorError(
      'server_runtime_missing',
      `No runtime bundle at ${runtimeDir} (${manifestPath} is missing). Run "artel server install", or set ARTEL_RUNTIME_DIR to an unpacked runtime directory.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalid(`at ${manifestPath} is not valid JSON`);
  }
  const manifest = parseManifest(parsed);
  const executables = {} as Record<ExecutableName, string>;
  for (const name of EXECUTABLE_NAMES) {
    executables[name] = absolute(runtimeDir, manifest.executables[name]);
  }
  const layout: RuntimeLayout = {
    runtimeDir,
    manifest,
    executables,
    orchestrationJar: absolute(runtimeDir, manifest.orchestrationJar),
    agentServerDir: absolute(runtimeDir, manifest.agentServerDir),
    homeDir: absolute(runtimeDir, manifest.homeDir),
  };
  const required = [
    ...Object.values(layout.executables),
    layout.orchestrationJar,
    layout.agentServerDir,
    layout.homeDir,
  ];
  for (const file of required) {
    if (!(await exists(file))) {
      throw new SupervisorError(
        'server_runtime_invalid',
        `The runtime bundle at ${runtimeDir} is incomplete: ${file} is missing. Reinstall it with "artel server install".`,
      );
    }
  }
  return layout;
}
