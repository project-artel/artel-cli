import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runDocUpload } from '../src/commands/doc/upload.js';
import type { DocumentUploadEvent } from '../src/doc/upload-flow.js';
import { CliError } from '../src/errors.js';
import { EXIT_FAILURE, EXIT_OK } from '../src/exit.js';
import type { DocumentUploadPayload } from '../src/output/contract.js';
import {
  documentFrame,
  documentSnapshot,
  FAKE_DOCUMENT_ID,
  FAKE_OBJECT_KEY,
  startFakeDocServer,
  type FakeDocServer,
} from './doc-helpers.js';
import { createMemorySink, waitUntil, type MemorySink } from './helpers.js';

const FAST = { reconnectDelaysMs: [5, 5, 5] } as const;

let api: FakeDocServer;
let root: string;
let pdfPath: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'artel-cli-doc-'));
  pdfPath = path.join(root, 'plan.pdf');
  await fs.writeFile(pdfPath, '%PDF-1.7\n\n');
});

afterEach(async () => {
  await api.close();
  await fs.rm(root, { recursive: true, force: true });
});

function envFor(server: FakeDocServer): NodeJS.ProcessEnv {
  return { ARTEL_TOKEN: 'artel_test_token', ARTEL_API_BASE_URL: server.baseUrl };
}

function uploadEvents(sink: MemorySink): DocumentUploadEvent[] {
  return sink.stderr
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as DocumentUploadEvent);
}

function baseOptions(): { json: true; project: string; timeoutSeconds: number } {
  return { json: true, project: '12', timeoutSeconds: 30 };
}

describe('doc upload', () => {
  it('issues a ticket, puts the bytes, registers, and never opens the stream without --watch', async () => {
    api = await startFakeDocServer();
    const sink = createMemorySink();

    const code = await runDocUpload(pdfPath, { ...baseOptions(), watch: false }, sink, envFor(api));

    expect(code).toBe(EXIT_OK);
    expect(api.ticketCalls).toHaveLength(1);
    expect(api.ticketCalls[0]?.body).toEqual({
      fileName: 'plan.pdf',
      contentType: 'application/pdf',
      sizeBytes: 10,
    });
    expect(api.putCalls).toHaveLength(1);
    expect(api.putCalls[0]?.bytes).toBe(10);
    expect(api.registerCalls[0]?.objectKey).toBe(FAKE_OBJECT_KEY);
    // 등록 뒤에도 stream 을 열지 않는다. 추출을 기다리는 것은 `--watch` 를 준 사람의 선택이다.
    expect(api.streamOpens).toHaveLength(0);

    const payload = sink.lastJson<DocumentUploadPayload>();
    expect(payload.documentId).toBe(FAKE_DOCUMENT_ID);
    expect(payload.version).toBe(3);
    expect(payload.parseStatus).toBe('PENDING');
    // 확인하지 않은 것과 확인해서 false 인 것은 다르다.
    expect(payload.stale).toBeNull();
    expect(payload.watched).toBe(false);
  });

  it('carries the required headers onto the presigned PUT and no Authorization', async () => {
    api = await startFakeDocServer();

    await runDocUpload(
      pdfPath,
      { ...baseOptions(), watch: false },
      createMemorySink(),
      envFor(api),
    );

    expect(api.putCalls[0]?.contentType).toBe('application/pdf');
    // presigned URL 자체가 서명이다. 자격 증명을 하나 더 얹으면 S3 가 서명 불일치로 거절한다.
    expect(api.putCalls[0]?.authorization).toBeNull();
    expect(api.ticketCalls[0]?.authorization).toBe('Bearer artel_test_token');
  });

  it('follows the extraction to EXTRACTED with --watch', async () => {
    api = await startFakeDocServer();
    const sink = createMemorySink();

    const uploading = runDocUpload(
      pdfPath,
      { ...baseOptions(), watch: true, ...FAST },
      sink,
      envFor(api),
    );

    await waitUntil(() => api.streamOpens.length > 0);
    api.emitDocument(documentSnapshot([{ documentId: FAKE_DOCUMENT_ID, parseStatus: 'PENDING' }]));
    api.emitDocument(documentFrame(FAKE_DOCUMENT_ID, 'EXTRACTING'));
    api.emitDocument(documentFrame(FAKE_DOCUMENT_ID, 'EXTRACTED'));

    expect(await uploading).toBe(EXIT_OK);
    expect(api.streamOpens[0]?.authorization).toBe('Bearer artel_test_token');

    const payload = sink.lastJson<DocumentUploadPayload>();
    expect(payload.parseStatus).toBe('EXTRACTED');
    expect(payload.stale).toBe(false);
    expect(payload.watched).toBe(true);
    expect(uploadEvents(sink).filter((event) => event.kind === 'parse-status')).toHaveLength(3);
  });

  it('finishes on a snapshot that already says EXTRACTED', async () => {
    api = await startFakeDocServer();
    const sink = createMemorySink();

    const uploading = runDocUpload(
      pdfPath,
      { ...baseOptions(), watch: true, ...FAST },
      sink,
      envFor(api),
    );

    await waitUntil(() => api.streamOpens.length > 0);
    // 추출이 stream 에 붙기 전에 이미 끝났을 수 있다. snapshot 이 그 경우를 덮는다.
    api.emitDocument(
      documentSnapshot([
        { documentId: '99', parseStatus: 'FAILED' },
        { documentId: FAKE_DOCUMENT_ID, parseStatus: 'EXTRACTED' },
      ]),
    );

    expect(await uploading).toBe(EXIT_OK);
    expect(sink.lastJson<DocumentUploadPayload>().parseStatus).toBe('EXTRACTED');
  });

  it('exits 1 when the extraction failed, and still prints the payload', async () => {
    api = await startFakeDocServer();
    const sink = createMemorySink();

    const uploading = runDocUpload(
      pdfPath,
      { ...baseOptions(), watch: true, ...FAST },
      sink,
      envFor(api),
    );

    await waitUntil(() => api.streamOpens.length > 0);
    api.emitDocument(documentFrame(FAKE_DOCUMENT_ID, 'FAILED'));

    expect(await uploading).toBe(EXIT_FAILURE);
    expect(sink.lastJson<DocumentUploadPayload>().documentId).toBe(FAKE_DOCUMENT_ID);
  });

  it('stops on a stale EXTRACTING instead of waiting for a row that will not move', async () => {
    api = await startFakeDocServer();
    const sink = createMemorySink();

    const uploading = runDocUpload(
      pdfPath,
      { ...baseOptions(), watch: true, ...FAST },
      sink,
      envFor(api),
    );

    await waitUntil(() => api.streamOpens.length > 0);
    api.emitDocument(documentFrame(FAKE_DOCUMENT_ID, 'EXTRACTING', true));

    expect(await uploading).toBe(EXIT_FAILURE);
    const payload = sink.lastJson<DocumentUploadPayload>();
    expect(payload.parseStatus).toBe('EXTRACTING');
    expect(payload.stale).toBe(true);
  });

  it('ignores frames about other documents', async () => {
    api = await startFakeDocServer();
    const sink = createMemorySink();

    const uploading = runDocUpload(
      pdfPath,
      { ...baseOptions(), watch: true, ...FAST },
      sink,
      envFor(api),
    );

    await waitUntil(() => api.streamOpens.length > 0);
    api.emitDocument(documentFrame('99', 'FAILED'));
    api.emitDocument(documentFrame('98', 'EXTRACTED'));
    api.emitDocument(documentFrame(FAKE_DOCUMENT_ID, 'EXTRACTED'));

    expect(await uploading).toBe(EXIT_OK);
    expect(uploadEvents(sink).filter((event) => event.kind === 'parse-status')).toHaveLength(1);
  });

  it('names the duplicate for what it is', async () => {
    api = await startFakeDocServer({
      registerFailure: {
        status: 409,
        body: '{"code":"duplicate_document","message":"이미 업로드된 파일입니다."}',
      },
    });

    const error = await runDocUpload(
      pdfPath,
      { ...baseOptions(), watch: false },
      createMemorySink(),
      envFor(api),
    ).then(
      () => null,
      (thrown: unknown) => thrown,
    );

    expect((error as CliError).code).toBe('document_duplicate');
  });

  it('reports a rejected upload ticket as document_rejected, not a bare server error', async () => {
    api = await startFakeDocServer({
      ticketFailure: {
        status: 400,
        body: '{"code":"invalid_document","message":"기획서는 PDF 파일만 올릴 수 있습니다."}',
      },
    });

    const error = await runDocUpload(
      pdfPath,
      { ...baseOptions(), watch: false },
      createMemorySink(),
      envFor(api),
    ).then(
      () => null,
      (thrown: unknown) => thrown,
    );

    expect((error as CliError).code).toBe('document_rejected');
    expect((error as CliError).message).toContain('Only a PDF is accepted');
    // 티켓이 거절되면 아무 바이트도 나가지 않는다.
    expect(api.putCalls).toHaveLength(0);
  });

  it('says nothing was registered when the storage PUT fails', async () => {
    api = await startFakeDocServer({ putStatus: 403 });

    const error = await runDocUpload(
      pdfPath,
      { ...baseOptions(), watch: false },
      createMemorySink(),
      envFor(api),
    ).then(
      () => null,
      (thrown: unknown) => thrown,
    );

    expect((error as CliError).code).toBe('document_upload_failed');
    expect((error as CliError).message).toContain('Nothing was registered');
    expect(api.registerCalls).toHaveLength(0);
  });

  it('refuses a file it cannot read before it calls the server', async () => {
    api = await startFakeDocServer();

    const error = await runDocUpload(
      path.join(root, 'missing.pdf'),
      { ...baseOptions(), watch: false },
      createMemorySink(),
      envFor(api),
    ).then(
      () => null,
      (thrown: unknown) => thrown,
    );

    expect((error as CliError).code).toBe('document_file_unreadable');
    expect(api.ticketCalls).toHaveLength(0);
  });

  it('refuses to run without a credential', async () => {
    api = await startFakeDocServer();

    const error = await runDocUpload(
      pdfPath,
      { ...baseOptions(), watch: false },
      createMemorySink(),
      { ARTEL_API_BASE_URL: api.baseUrl, HOME: root, USERPROFILE: root },
    ).then(
      () => null,
      (thrown: unknown) => thrown,
    );

    expect((error as CliError).code).toBe('no_credential');
  });
});
