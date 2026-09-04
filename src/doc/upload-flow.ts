import fs from 'node:fs/promises';
import path from 'node:path';

import { CliError } from '../errors.js';
import type { FetchLike } from '../http/client.js';
import {
  createUploadTicket,
  DOCUMENT_CONTENT_TYPE,
  openDocumentEvents,
  putDocumentObject,
  readDocumentStreamEvent,
  registerDocument,
  type DocumentParseStatus,
  type ProjectDocument,
} from '../http/documents.js';
import { watchSse } from '../http/sse.js';

/** 추출이 더는 움직이지 않는 상태. */
const TERMINAL_PARSE_STATUSES = new Set(['EXTRACTED', 'FAILED']);

export const DEFAULT_UPLOAD_RECONNECT_DELAYS_MS: readonly number[] = [
  500, 1_000, 2_000, 4_000, 8_000,
];

/** `doc upload` 가 보고하는 사건. 사람용 한 줄과 `--json` 의 NDJSON 이 모두 여기서 나온다. */
export type DocumentUploadEvent =
  | { kind: 'ticket'; objectKey: string; expiresAt: string }
  | { kind: 'uploaded'; sizeBytes: number }
  | { kind: 'registered'; documentId: string; version: number; parseStatus: string }
  | { kind: 'parse-status'; documentId: string; parseStatus: string; stale: boolean }
  | { kind: 'reconnect'; attempt: number; of: number; delayMs: number };

export interface UploadDocumentOptions {
  apiBaseUrl: string;
  cliToken: string;
  projectId: string;
  filePath: string;
  watch: boolean;
  /** `0` 이면 상한 없음. `watch` 가 아니면 쓰이지 않는다. */
  timeoutMs: number;
  onEvent: (event: DocumentUploadEvent) => void;
  fetchImpl?: FetchLike | undefined;
  reconnectDelaysMs?: readonly number[] | undefined;
}

export interface UploadedDocument {
  document: ProjectDocument;
  /** 마지막으로 확인한 값. `watch` 가 아니면 등록 응답의 값 그대로다. */
  parseStatus: string;
  /** `watch` 가 아니면 `null` — 서버가 추출을 놓쳤는지는 stream 만 말해 준다. */
  stale: boolean | null;
  watched: boolean;
}

/**
 * 기획서 한 벌을 올리고, 부탁하면 추출이 끝나는 것까지 본다.
 *
 * 세 번의 호출은 순서가 곧 의미다. 티켓을 받고, 바이트를 S3 로 직접 올리고, 등록한다 —
 * 등록이 성공해야 문서가 존재하고, 그 전에 죽으면 S3 에 주인 없는 객체 하나가 남을 뿐
 * 프로젝트에는 아무 일도 일어나지 않는다.
 *
 * **등록한 뒤에 stream 에 붙어도 늦지 않다.** 서버가 구독 직후 보내는 `snapshot` 이 구독
 * 시점의 DB 를 그대로 실어 오므로, 붙기 전에 이미 끝난 추출도 첫 frame 에서 보인다.
 */
export async function uploadDocument(options: UploadDocumentOptions): Promise<UploadedDocument> {
  const fileName = path.basename(options.filePath);
  const bytes = await readFileBytes(options.filePath);

  const ticket = await createUploadTicket(
    options.apiBaseUrl,
    options.cliToken,
    options.projectId,
    { fileName, contentType: DOCUMENT_CONTENT_TYPE, sizeBytes: bytes.byteLength },
    options.fetchImpl,
  );
  options.onEvent({ kind: 'ticket', objectKey: ticket.objectKey, expiresAt: ticket.expiresAt });

  await putDocumentObject(ticket, bytes, options.fetchImpl ?? globalThis.fetch);
  options.onEvent({ kind: 'uploaded', sizeBytes: bytes.byteLength });

  const document = await registerDocument(
    options.apiBaseUrl,
    options.cliToken,
    options.projectId,
    ticket.objectKey,
    options.fetchImpl,
  );
  options.onEvent({
    kind: 'registered',
    documentId: document.documentId,
    version: document.version,
    parseStatus: document.parseStatus,
  });

  if (!options.watch) {
    return { document, parseStatus: document.parseStatus, stale: null, watched: false };
  }

  const final = await watchExtraction(options, document.documentId);
  return { document, parseStatus: final.parseStatus, stale: final.stale, watched: true };
}

/**
 * `parse_status` 가 `EXTRACTED` 나 `FAILED` 에 닿을 때까지 본다.
 *
 * `stale` 도 종단으로 다룬다. 그 값은 "서버가 이 추출을 들고 있지 않다" 는 뜻이라, 기다려도
 * 행이 움직이지 않는다 — 기다리는 것과 굳은 것을 같이 두면 명령이 timeout 까지 침묵한다.
 */
async function watchExtraction(
  options: UploadDocumentOptions,
  documentId: string,
): Promise<DocumentParseStatus> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const reconnectDelaysMs = options.reconnectDelaysMs ?? DEFAULT_UPLOAD_RECONNECT_DELAYS_MS;
  let lastReported: string | null = null;

  return await watchSse<DocumentParseStatus>({
    open: (signal) =>
      openDocumentEvents(
        options.apiBaseUrl,
        options.cliToken,
        options.projectId,
        signal,
        fetchImpl,
      ),
    read: (frame) => {
      const status = readDocumentStreamEvent(frame.data, documentId);
      if (status === null) {
        return null;
      }
      const line = `${status.parseStatus}:${String(status.stale)}`;
      if (line !== lastReported) {
        lastReported = line;
        options.onEvent({ kind: 'parse-status', ...status });
      }
      if (TERMINAL_PARSE_STATUSES.has(status.parseStatus) || status.stale) {
        return status;
      }
      return null;
    },
    timeoutMs: options.timeoutMs,
    reconnectDelaysMs,
    onReconnect: (attempt, of, delayMs) => {
      options.onEvent({ kind: 'reconnect', attempt, of, delayMs });
    },
    onTimeout: () =>
      new CliError(
        'document_watch_timeout',
        `Stopped watching document ${documentId} after ${String(Math.round(options.timeoutMs / 1_000))}s. The document is registered and the extraction keeps going on the server; raise --timeout, or read the status later.`,
      ),
    onDisconnected: (attempts) =>
      new CliError(
        'document_watch_disconnected',
        `Lost the document event stream for project ${options.projectId} and could not reconnect after ${String(attempts)} attempts. Document ${documentId} is registered either way; only the progress view was lost.`,
      ),
  });
}

async function readFileBytes(filePath: string): Promise<Uint8Array> {
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    throw new CliError(
      'document_file_unreadable',
      `Could not read ${filePath}: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
}
