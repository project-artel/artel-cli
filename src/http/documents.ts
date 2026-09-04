import { CliError } from '../errors.js';
import type { FetchLike } from './client.js';
import { parseHttpFailure, toCliError } from './errors.js';
import { asNullableString, asNumber, asObject, asString, requestJson } from './json.js';

/**
 * `ProjectDocumentController`(orchestration `project/controller/ProjectDocumentController.kt`).
 *
 * 기획서 한 벌을 올리는 데 세 번 부른다.
 *
 * 1. `POST .../documents/upload-url` — presigned URL 을 받는다
 * 2. 그 URL 로 파일을 그대로 `PUT` 한다. **서버를 지나지 않는다**
 * 3. `POST .../documents` — 올라온 객체를 한 버전으로 등록한다
 *
 * 등록이 성공해야 기획서가 존재한다. 그 뒤로는 서버가 알아서
 * `DocumentKnowledgeExtractionService` 를 띄우고, 진행은 `parse_status` 로만 보인다.
 */
export function projectDocumentsPath(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/documents`;
}

/** 서버가 PDF 만 받는다(`ProjectDocumentService.PDF_CONTENT_TYPE`). */
export const DOCUMENT_CONTENT_TYPE = 'application/pdf';

/** 파일 하나를 통째로 올리는 데는 `requestJson` 의 15초가 짧다. */
const UPLOAD_TIMEOUT_MS = 300_000;

/** `UploadTicketResponse`. */
export interface UploadTicket {
  uploadUrl: string;
  objectKey: string;
  /** `PUT` 에 그대로 실어야 하는 헤더. 서명에 들어 있어 하나라도 빠지면 S3 가 거절한다. */
  requiredHeaders: Record<string, string>;
  expiresAt: string;
}

/** `ProjectDocumentResponse`. */
export interface ProjectDocument {
  documentId: string;
  version: number;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: string;
  uploadedById: string;
  uploadedByName: string;
  /** `PENDING` · `EXTRACTING` · `EXTRACTED` · `FAILED`. */
  parseStatus: string;
}

/** `DocumentParseStatusResponse`. */
export interface DocumentParseStatus {
  documentId: string;
  parseStatus: string;
  /**
   * `parseStatus` 가 `EXTRACTING` 인데 서버가 그 추출을 들고 있지 않다. 추출은 서버 메모리
   * 위의 fire-and-forget 이라, 서버가 재시작하면 행이 `EXTRACTING` 인 채로 굳는다. 이 값이
   * `true` 면 기다려도 움직이지 않는다.
   */
  stale: boolean;
}

/** `POST /api/projects/{projectId}/documents/upload-url`. */
export async function createUploadTicket(
  apiBaseUrl: string,
  cliToken: string,
  projectId: string,
  request: { fileName: string; contentType: string; sizeBytes: number },
  fetchImpl?: FetchLike,
): Promise<UploadTicket> {
  const endpoint = `${apiBaseUrl}${projectDocumentsPath(projectId)}/upload-url`;
  const body = await requestJson({
    method: 'POST',
    endpoint,
    cliToken,
    body: request,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    onFailure: (failure) => {
      if (failure.status === 404) {
        return new CliError(
          'document_project_not_found',
          `There is no project ${projectId}, or you cannot see it.`,
        );
      }
      if (failure.status === 400) {
        return new CliError(
          'document_rejected',
          `The server refused ${request.fileName}: ${failure.message ?? 'it is outside the upload rules'}. Only a PDF is accepted, and it must be under the deployment's size limit.`,
        );
      }
      return null;
    },
  });

  const ticket = asObject(body, 'body', endpoint);
  return {
    uploadUrl: asString(ticket['uploadUrl'], 'uploadUrl', endpoint),
    objectKey: asString(ticket['objectKey'], 'objectKey', endpoint),
    requiredHeaders: readHeaders(ticket['requiredHeaders'], endpoint),
    expiresAt: asString(ticket['expiresAt'], 'expiresAt', endpoint),
  };
}

/**
 * 파일 바이트를 presigned URL 로 그대로 올린다.
 *
 * **`Authorization` 을 싣지 않는다.** URL 자체가 서명이라, 자격 증명을 하나 더 얹으면 S3 가
 * 서명 불일치로 거절한다. 서버가 준 `requiredHeaders` 는 반대로 하나도 빠뜨리면 안 된다 —
 * `Content-Type` 이 서명에 들어 있다.
 */
export async function putDocumentObject(
  ticket: UploadTicket,
  bytes: Uint8Array,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(ticket.uploadUrl, {
      method: 'PUT',
      headers: ticket.requiredHeaders,
      body: bytes,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    throw new CliError(
      'network_error',
      `Could not reach the upload URL for ${ticket.objectKey}: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }

  if (!response.ok) {
    throw new CliError(
      'document_upload_failed',
      `The storage service answered HTTP ${String(response.status)} to the upload of ${ticket.objectKey}. Nothing was registered, so no document version exists; the upload URL may have expired (it is short-lived) — run the command again.`,
    );
  }
}

/** `POST /api/projects/{projectId}/documents`. 이 호출이 성공해야 기획서가 존재한다. */
export async function registerDocument(
  apiBaseUrl: string,
  cliToken: string,
  projectId: string,
  objectKey: string,
  fetchImpl?: FetchLike,
): Promise<ProjectDocument> {
  const endpoint = `${apiBaseUrl}${projectDocumentsPath(projectId)}`;
  const body = await requestJson({
    method: 'POST',
    endpoint,
    cliToken,
    body: { objectKey },
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    onFailure: (failure) => {
      if (failure.status === 404) {
        return new CliError(
          'document_project_not_found',
          `There is no project ${projectId}, or you cannot see it.`,
        );
      }
      if (failure.code === 'duplicate_document') {
        return new CliError(
          'document_duplicate',
          `Project ${projectId} already holds a document with these exact bytes, so this upload was discarded. Delete the existing version first if you meant to re-upload it.`,
        );
      }
      if (failure.status === 400) {
        return new CliError(
          'document_rejected',
          `The server refused the uploaded object: ${failure.message ?? 'it is outside the upload rules'}.`,
        );
      }
      return null;
    },
  });

  return parseDocument(body, endpoint);
}

/**
 * `GET /api/projects/{projectId}/documents/events`. **SSE 다.**
 *
 * 구독 직후 `snapshot` 이 한 번 오고, 그 뒤로 `parse_status` 가 바뀔 때마다 `document` 가 온다.
 * 등록 뒤에 붙어도 늦지 않다 — snapshot 이 구독 시점의 DB 를 그대로 실어 오므로, 붙기 전에
 * 이미 끝난 추출도 첫 frame 에서 보인다.
 *
 * 컨트롤러 KDoc 은 브라우저 `EventSource` 를 전제로 cookie 를 말하지만, `SecurityConfig` 의
 * bearer token converter 는 `Authorization` header 를 먼저 보고 없을 때만 cookie 로 떨어진다.
 * CLI 의 Bearer token 이 그대로 통한다.
 */
export async function openDocumentEvents(
  apiBaseUrl: string,
  cliToken: string,
  projectId: string,
  signal: AbortSignal,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<Response> {
  const endpoint = `${apiBaseUrl}${projectDocumentsPath(projectId)}/events`;
  return await openEventStream(endpoint, cliToken, signal, fetchImpl, (failure) =>
    failure.status === 404
      ? new CliError(
          'document_project_not_found',
          `There is no project ${projectId}, or you cannot see it.`,
        )
      : null,
  );
}

/** `DocumentStreamEvent` 한 장에서 이 문서의 상태를 찾는다. 다른 문서 이야기면 `null`. */
export function readDocumentStreamEvent(
  data: string,
  documentId: string,
): DocumentParseStatus | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const frame = parsed as { document?: unknown; documents?: unknown };
  const candidates: unknown[] = Array.isArray(frame.documents)
    ? frame.documents
    : frame.document === undefined || frame.document === null
      ? []
      : [frame.document];

  for (const candidate of candidates) {
    const status = readParseStatus(candidate);
    if (status !== null && status.documentId === documentId) {
      return status;
    }
  }
  return null;
}

function readParseStatus(value: unknown): DocumentParseStatus | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const documentId = record['documentId'];
  const parseStatus = record['parseStatus'];
  if (typeof documentId !== 'string' || typeof parseStatus !== 'string') {
    return null;
  }
  return {
    documentId,
    parseStatus,
    stale: record['stale'] === true,
  };
}

function parseDocument(body: unknown, endpoint: string): ProjectDocument {
  const record = asObject(body, 'body', endpoint);
  const uploader = asObject(record['uploadedBy'], 'uploadedBy', endpoint);
  return {
    documentId: asString(record['id'], 'id', endpoint),
    version: asNumber(record['version'], 'version', endpoint),
    fileName: asString(record['fileName'], 'fileName', endpoint),
    contentType: asString(record['contentType'], 'contentType', endpoint),
    sizeBytes: asNumber(record['sizeBytes'], 'sizeBytes', endpoint),
    uploadedAt: asString(record['uploadedAt'], 'uploadedAt', endpoint),
    uploadedById: asString(uploader['id'], 'uploadedBy.id', endpoint),
    uploadedByName:
      asNullableString(uploader['displayName'], 'uploadedBy.displayName', endpoint) ?? '',
    parseStatus: asString(record['parseStatus'], 'parseStatus', endpoint),
  };
}

function readHeaders(value: unknown, endpoint: string): Record<string, string> {
  const record = asObject(value, 'requiredHeaders', endpoint);
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(record)) {
    if (typeof headerValue !== 'string') {
      throw new CliError(
        'server_error',
        `${endpoint} answered with a "requiredHeaders.${name}" that is not a string.`,
      );
    }
    headers[name] = headerValue;
  }
  return headers;
}

/**
 * SSE 를 여는 공통 자리. `requestJson` 을 쓸 수 없다 — 그쪽은 body 를 끝까지 읽어 JSON 으로
 * 파싱하므로, 서버가 먼저 끊지 않는 stream 에서는 영원히 돌아오지 않는다.
 */
export async function openEventStream(
  endpoint: string,
  cliToken: string,
  signal: AbortSignal,
  fetchImpl: FetchLike,
  onFailure: (failure: ReturnType<typeof parseHttpFailure>) => CliError | null,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'GET',
      headers: { authorization: `Bearer ${cliToken}`, accept: 'text/event-stream' },
      signal,
    });
  } catch (error) {
    throw new CliError(
      'network_error',
      `Could not reach ${endpoint}: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }

  if (!response.ok) {
    let text: string;
    try {
      text = await response.text();
    } catch {
      text = '';
    }
    const failure = parseHttpFailure(response.status, text);
    throw onFailure(failure) ?? toCliError(endpoint, failure);
  }

  return response;
}
