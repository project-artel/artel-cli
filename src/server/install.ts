import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

import { SupervisorError } from './errors.js';
import { loadRuntime, type RuntimeLayout } from './manifest.js';
import { isPidAlive } from './state-file.js';
import { dataPaths, RUNTIME_VERSION, resolveRuntimeDir, type RuntimeTarget } from './paths.js';

export const RUNTIME_RELEASE_BASE_URL =
  'https://github.com/project-artel/artel-desktop/releases/download';

export function runtimeArchiveName(version: string, target: RuntimeTarget): string {
  return `artel-runtime-${version}-${target}.tar.gz`;
}

/** 공유 계약 2절의 주소: `<base>/runtime-v<version>/<archive>`. */
export function runtimeArchiveUrl(
  version: string,
  target: RuntimeTarget,
  baseUrl = RUNTIME_RELEASE_BASE_URL,
): string {
  return `${baseUrl.replace(/\/+$/, '')}/runtime-v${version}/${runtimeArchiveName(version, target)}`;
}

/** `.sha256` 파일은 `<hex digest>  <file name>` 한 줄이다. 이름 없이 digest 만 있어도 받는다. */
export function parseChecksumFile(text: string, archiveName: string): string {
  const line = text.trim().split(/\r?\n/)[0] ?? '';
  const match = /^([0-9a-fA-F]{64})(?:\s+\*?(.+))?$/.exec(line.trim());
  if (match === null) {
    throw new SupervisorError(
      'server_install_failed',
      `The checksum file for ${archiveName} is not "<sha256>  <file name>".`,
    );
  }
  const name = match[2]?.trim();
  if (name !== undefined && name !== archiveName) {
    throw new SupervisorError(
      'server_install_failed',
      `The checksum file names ${name}, not ${archiveName}.`,
    );
  }
  return (match[1] ?? '').toLowerCase();
}

/** 시스템의 `tar`. Windows 10 이후에는 bsdtar 가 `System32\tar.exe` 로 들어 있다. */
export function systemTar(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform !== 'win32') return 'tar';
  // Git Bash 의 GNU tar 가 PATH 에 먼저 있으면 `C:` 를 원격 host 로 읽는다. 경로를 고정한다.
  return path.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
}

function runTar(args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(systemTar(), [...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (error) => {
      reject(
        new SupervisorError(
          'server_install_failed',
          `Could not run tar to unpack the runtime: ${error.message}`,
        ),
      );
    });
    child.once('close', (code) => {
      if (code === 0) resolve();
      else
        reject(
          new SupervisorError(
            'server_install_failed',
            `tar exited with code ${String(code)} while unpacking the runtime: ${stderr.trim()}`,
          ),
        );
    });
  });
}

export interface InstallOptions {
  version: string;
  target: RuntimeTarget;
  dataDir: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  onProgress?: (message: string) => void;
  /** archive 를 받는 동안 받은 byte 수와 전체 크기. `Content-Length` 가 없으면 `total` 은 `null`. */
  onDownloadProgress?: (received: number, total: number | null) => void;
}

export interface InstallResult {
  version: string;
  target: RuntimeTarget;
  runtimeDir: string;
  alreadyInstalled: boolean;
  sha256: string | null;
}

async function fetchOk(fetchImpl: typeof fetch, url: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(url, { redirect: 'follow' });
  } catch (error) {
    throw new SupervisorError(
      'server_install_failed',
      `Could not download ${url}: ${(error as Error).message}`,
    );
  }
  if (!response.ok || response.body === null) {
    throw new SupervisorError(
      'server_install_failed',
      `Downloading ${url} returned HTTP ${String(response.status)}.`,
    );
  }
  return response;
}

/**
 * Ctrl-C 나 SIGKILL 로 끝난 install 은 `finally` 를 지나지 않아 `.install-<pid>` 를 남긴다. 그 pid 가
 * 더는 살아 있지 않으면 지운다. runtime 디렉터리 자체는 다 푼 뒤에 rename 하므로 남지 않는다.
 */
async function removeAbandonedWorkDirs(runtimeRoot: string): Promise<void> {
  const entries = await fsp.readdir(runtimeRoot).catch(() => [] as string[]);
  for (const name of entries) {
    const match = /^\.install-(\d+)$/.exec(name);
    if (match === null) continue;
    const pid = Number.parseInt(match[1] ?? '', 10);
    if (pid !== process.pid && !isPidAlive(pid)) {
      await fsp.rm(path.join(runtimeRoot, name), { recursive: true, force: true });
    }
  }
}

/** archive 를 풀면 한 디렉터리가 나온다. 이름은 정해져 있지 않아 `manifest.json` 으로 찾는다. */
async function locateRuntimeRoot(extractDir: string): Promise<string> {
  if (fs.existsSync(path.join(extractDir, 'manifest.json'))) return extractDir;
  const entries = (await fsp.readdir(extractDir, { withFileTypes: true })).filter((entry) =>
    entry.isDirectory(),
  );
  for (const entry of entries) {
    const candidate = path.join(extractDir, entry.name);
    if (fs.existsSync(path.join(candidate, 'manifest.json'))) return candidate;
  }
  throw new SupervisorError(
    'server_install_failed',
    'The runtime archive has no manifest.json at its top level.',
  );
}

async function existingRuntime(runtimeDir: string): Promise<RuntimeLayout | null> {
  try {
    return await loadRuntime(runtimeDir);
  } catch {
    return null;
  }
}

/**
 * runtime bundle 을 받아 SHA-256 을 확인하고 `<dataDir>/runtime/<version>` 에 푼다. 이미 온전한
 * 것이 있으면 받지 않는다. 다 푼 뒤에 옮기므로 도중에 실패해도 반쯤 풀린 runtime 이 남지 않는다.
 */
export async function installRuntime(options: InstallOptions): Promise<InstallResult> {
  const paths = dataPaths(options.dataDir);
  const runtimeDir = path.join(paths.runtimeRoot, options.version);
  const existing = await existingRuntime(runtimeDir);
  if (existing !== null && existing.manifest.version === options.version) {
    return {
      version: options.version,
      target: options.target,
      runtimeDir,
      alreadyInstalled: true,
      sha256: null,
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const archiveName = runtimeArchiveName(options.version, options.target);
  const archiveUrl = runtimeArchiveUrl(options.version, options.target, options.baseUrl);
  const workDir = path.join(paths.runtimeRoot, `.install-${String(process.pid)}`);
  await removeAbandonedWorkDirs(paths.runtimeRoot);
  await fsp.rm(workDir, { recursive: true, force: true });
  await fsp.mkdir(workDir, { recursive: true });

  try {
    options.onProgress?.(`Downloading ${archiveUrl}.sha256`);
    const checksumResponse = await fetchOk(fetchImpl, `${archiveUrl}.sha256`);
    const expected = parseChecksumFile(await checksumResponse.text(), archiveName);

    options.onProgress?.(`Downloading ${archiveUrl}`);
    const archiveResponse = await fetchOk(fetchImpl, archiveUrl);
    const archivePath = path.join(workDir, archiveName);
    const hash = crypto.createHash('sha256');
    const lengthHeader = Number.parseInt(archiveResponse.headers.get('content-length') ?? '', 10);
    const total = Number.isInteger(lengthHeader) && lengthHeader > 0 ? lengthHeader : null;
    let received = 0;
    const body = Readable.fromWeb(archiveResponse.body as unknown as WebReadableStream<Uint8Array>);
    body.on('data', (chunk: Buffer) => {
      hash.update(chunk);
      received += chunk.length;
      options.onDownloadProgress?.(received, total);
    });
    await pipeline(body, fs.createWriteStream(archivePath));
    const actual = hash.digest('hex');
    if (actual !== expected) {
      throw new SupervisorError(
        'server_checksum_mismatch',
        `The runtime archive's SHA-256 is ${actual}, but ${archiveName}.sha256 says ${expected}. The download is damaged or was replaced; nothing was installed.`,
      );
    }

    options.onProgress?.(`Unpacking ${archiveName}`);
    const extractDir = path.join(workDir, 'extract');
    await fsp.mkdir(extractDir);
    await runTar(['-xzf', archivePath, '-C', extractDir]);
    const root = await locateRuntimeRoot(extractDir);
    const layout = await loadRuntime(root);
    if (layout.manifest.version !== options.version || layout.manifest.target !== options.target) {
      throw new SupervisorError(
        'server_install_failed',
        `The archive holds runtime ${layout.manifest.version} for ${layout.manifest.target}, not ${options.version} for ${options.target}.`,
      );
    }

    await fsp.rm(runtimeDir, { recursive: true, force: true });
    await fsp.rename(root, runtimeDir);
    return {
      version: options.version,
      target: options.target,
      runtimeDir,
      alreadyInstalled: false,
      sha256: actual,
    };
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true });
  }
}

export interface EnsureRuntimeOptions {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  /** `false` 면 없는 runtime 을 받지 않고 실패한다(`--no-install`). */
  allowInstall: boolean;
  target: RuntimeTarget;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  onProgress?: (message: string) => void;
  onDownloadProgress?: (received: number, total: number | null) => void;
}

export interface EnsureRuntimeResult {
  runtimeDir: string;
  /** 이번 호출이 runtime 을 받아 설치했으면 `true`. */
  installed: boolean;
}

/**
 * `artel server start` 가 supervisor 를 띄우기 전에 부른다. runtime 디렉터리가 기본 위치
 * `<dataDir>/runtime/<RUNTIME_VERSION>` 이고 `manifest.json` 이 없을 때만 `installRuntime` 으로
 * 받는다. `ARTEL_RUNTIME_DIR` 이 가리키는 runtime 은 desktop app 이 함께 넣은 것이라 받아서
 * 바꾸지 않는다: 없으면 supervisor 가 `server_runtime_missing` 으로 실패한다.
 */
export async function ensureRuntime(options: EnsureRuntimeOptions): Promise<EnsureRuntimeResult> {
  const env = options.env ?? process.env;
  const runtimeDir = resolveRuntimeDir(options.dataDir, undefined, env);
  const defaultDir = path.join(dataPaths(options.dataDir).runtimeRoot, RUNTIME_VERSION);
  if (path.resolve(runtimeDir) !== path.resolve(defaultDir)) {
    return { runtimeDir, installed: false };
  }
  if (fs.existsSync(path.join(runtimeDir, 'manifest.json'))) {
    return { runtimeDir, installed: false };
  }
  if (!options.allowInstall) {
    throw new SupervisorError(
      'server_runtime_missing',
      `No runtime bundle at ${runtimeDir}. Run "artel server install", or drop --no-install to download it as part of start.`,
    );
  }
  const result = await installRuntime({
    version: RUNTIME_VERSION,
    target: options.target,
    dataDir: options.dataDir,
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    ...(options.onDownloadProgress === undefined
      ? {}
      : { onDownloadProgress: options.onDownloadProgress }),
  });
  return { runtimeDir: result.runtimeDir, installed: !result.alreadyInstalled };
}
