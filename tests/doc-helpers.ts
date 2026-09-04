import http from 'node:http';

/**
 * orchestration 서버와 S3 를 한 프로세스로 흉내 낸다. mocking 라이브러리를 끌어오지 않고
 * 진짜 loopback HTTP 를 쓰는 것은 이 저장소의 다른 테스트와 같은 규율이다 — `--watch` 는
 * 실제 SSE 를 읽으므로, `fetch` 를 가짜로 바꾸면 검증되는 것이 남지 않는다.
 */
export interface DocumentUploadCall {
  authorization: string | null;
  projectId: string;
  body: { fileName: string; contentType: string; sizeBytes: number };
}

export interface DocumentPutCall {
  authorization: string | null;
  contentType: string | null;
  bytes: number;
}

export interface DocumentRegisterCall {
  authorization: string | null;
  projectId: string;
  objectKey: string;
}

export interface ScanCall {
  authorization: string | null;
  projectId: string;
  gameBuildId: string;
}

export interface StreamOpen {
  path: string;
  authorization: string | null;
  accept: string | null;
}

export interface FakeDocServerOptions {
  /** 업로드 티켓 발급이 이 status 와 body 로 실패한다. */
  ticketFailure?: { status: number; body: string };
  /** presigned PUT 이 이 status 로 실패한다. */
  putStatus?: number;
  /** 등록이 이 status 와 body 로 실패한다. */
  registerFailure?: { status: number; body: string };
  /** 등록 응답의 `parseStatus`. 기본은 `PENDING` 이다. */
  registeredParseStatus?: string;
  /** `POST .../content-map/scan` 이 답할 status. 기본은 202. */
  scanStatus?: number;
  /** 202 가 아닐 때 실을 body. */
  scanFailureBody?: string;
}

export interface FakeDocServer {
  baseUrl: string;
  ticketCalls: DocumentUploadCall[];
  putCalls: DocumentPutCall[];
  registerCalls: DocumentRegisterCall[];
  scanCalls: ScanCall[];
  streamOpens: StreamOpen[];
  /** 열려 있는 문서 stream 전부에 frame 을 흘린다. */
  emitDocument(event: unknown): void;
  /** 열려 있는 content map stream 전부에 frame 을 흘린다. */
  emitContentMap(event: unknown): void;
  /** 열려 있는 stream 을 서버 쪽에서 끊는다. 재연결 경로를 검증하는 손잡이. */
  dropStreams(): void;
  close(): Promise<void>;
}

const DOCUMENT_ID = '77';
const OBJECT_KEY = 'projects/12/documents/plan.pdf';

export async function startFakeDocServer(
  options: FakeDocServerOptions = {},
): Promise<FakeDocServer> {
  const ticketCalls: DocumentUploadCall[] = [];
  const putCalls: DocumentPutCall[] = [];
  const registerCalls: DocumentRegisterCall[] = [];
  const scanCalls: ScanCall[] = [];
  const streamOpens: StreamOpen[] = [];
  let documentStreams: http.ServerResponse[] = [];
  let contentMapStreams: http.ServerResponse[] = [];

  const server = http.createServer((request, response) => {
    const authorization = request.headers.authorization ?? null;
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');

    if (request.method === 'PUT' && url.pathname === '/storage/upload') {
      readBody(request, (body) => {
        putCalls.push({
          authorization,
          contentType: request.headers['content-type'] ?? null,
          bytes: body.byteLength,
        });
        response.writeHead(options.putStatus ?? 200);
        response.end();
      });
      return;
    }

    const ticketMatch = /^\/api\/projects\/([^/]+)\/documents\/upload-url$/.exec(url.pathname);
    if (request.method === 'POST' && ticketMatch !== null) {
      readBody(request, (body) => {
        const parsed = JSON.parse(body.toString('utf8')) as DocumentUploadCall['body'];
        ticketCalls.push({
          authorization,
          projectId: decodeURIComponent(ticketMatch[1] ?? ''),
          body: parsed,
        });
        if (options.ticketFailure !== undefined) {
          respondJson(response, options.ticketFailure.status, options.ticketFailure.body);
          return;
        }
        respondJson(
          response,
          200,
          JSON.stringify({
            uploadUrl: `${baseUrlOf(server)}/storage/upload`,
            objectKey: OBJECT_KEY,
            requiredHeaders: { 'Content-Type': 'application/pdf' },
            expiresAt: '2026-09-04T00:15:00Z',
          }),
        );
      });
      return;
    }

    const documentsMatch = /^\/api\/projects\/([^/]+)\/documents$/.exec(url.pathname);
    if (request.method === 'POST' && documentsMatch !== null) {
      readBody(request, (body) => {
        const parsed = JSON.parse(body.toString('utf8')) as { objectKey: string };
        registerCalls.push({
          authorization,
          projectId: decodeURIComponent(documentsMatch[1] ?? ''),
          objectKey: parsed.objectKey,
        });
        if (options.registerFailure !== undefined) {
          respondJson(response, options.registerFailure.status, options.registerFailure.body);
          return;
        }
        respondJson(
          response,
          201,
          JSON.stringify({
            id: DOCUMENT_ID,
            version: 3,
            fileName: 'plan.pdf',
            contentType: 'application/pdf',
            sizeBytes: 10,
            uploadedAt: '2026-09-04T00:10:00Z',
            uploadedBy: { id: '5', displayName: 'Test User' },
            parseStatus: options.registeredParseStatus ?? 'PENDING',
          }),
        );
      });
      return;
    }

    const documentEventsMatch = /^\/api\/projects\/([^/]+)\/documents\/events$/.exec(url.pathname);
    if (request.method === 'GET' && documentEventsMatch !== null) {
      streamOpens.push({
        path: url.pathname,
        authorization,
        accept: request.headers.accept ?? null,
      });
      openStream(response);
      documentStreams.push(response);
      request.on('close', () => {
        documentStreams = documentStreams.filter((open) => open !== response);
      });
      return;
    }

    const scanMatch = /^\/api\/projects\/([^/]+)\/game-builds\/([^/]+)\/content-map\/scan$/.exec(
      url.pathname,
    );
    if (request.method === 'POST' && scanMatch !== null) {
      readBody(request, () => {
        scanCalls.push({
          authorization,
          projectId: decodeURIComponent(scanMatch[1] ?? ''),
          gameBuildId: decodeURIComponent(scanMatch[2] ?? ''),
        });
        const status = options.scanStatus ?? 202;
        if (status !== 202) {
          respondJson(response, status, options.scanFailureBody ?? '{}');
          return;
        }
        respondJson(
          response,
          202,
          JSON.stringify({
            gameInstanceId: 9,
            gameInstanceName: 'wordventure-dev',
            state: 'REQUESTED',
            requestedAt: '2026-09-04T00:20:00Z',
          }),
        );
      });
      return;
    }

    const contentMapEventsMatch =
      /^\/api\/projects\/([^/]+)\/game-builds\/([^/]+)\/content-map\/events$/.exec(url.pathname);
    if (request.method === 'GET' && contentMapEventsMatch !== null) {
      streamOpens.push({
        path: url.pathname,
        authorization,
        accept: request.headers.accept ?? null,
      });
      openStream(response);
      contentMapStreams.push(response);
      request.on('close', () => {
        contentMapStreams = contentMapStreams.filter((open) => open !== response);
      });
      return;
    }

    respondJson(response, 404, '{"code":"not_found","message":"no such route"}');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const write = (streams: http.ServerResponse[], event: unknown): void => {
    const frame = event as { type?: unknown };
    const name = typeof frame.type === 'string' ? frame.type : 'message';
    for (const stream of streams) {
      stream.write(`event: ${name}\ndata: ${JSON.stringify(event)}\n\n`);
    }
  };

  return {
    baseUrl: baseUrlOf(server),
    ticketCalls,
    putCalls,
    registerCalls,
    scanCalls,
    streamOpens,
    emitDocument(event) {
      write(documentStreams, event);
    },
    emitContentMap(event) {
      write(contentMapStreams, event);
    },
    dropStreams() {
      for (const stream of [...documentStreams, ...contentMapStreams]) {
        stream.end();
      }
      documentStreams = [];
      contentMapStreams = [];
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    },
  };
}

function baseUrlOf(server: http.Server): string {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the fake document server did not bind to a TCP port');
  }
  return `http://127.0.0.1:${String(address.port)}`;
}

function readBody(request: http.IncomingMessage, done: (body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => done(Buffer.concat(chunks)));
}

function respondJson(response: http.ServerResponse, status: number, body: string): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(body);
}

function openStream(response: http.ServerResponse): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  // 헤더만으로는 client 의 fetch 가 body 를 읽기 시작하지 않을 수 있다. 주석 한 줄을 먼저
  // 흘려 stream 이 실제로 열렸다는 것을 알린다.
  response.write(': open\n\n');
}

/** 문서 stream 의 `document` frame. */
export function documentFrame(
  documentId: string,
  parseStatus: string,
  stale = false,
): Record<string, unknown> {
  return { type: 'document', document: { documentId, parseStatus, stale } };
}

/** 문서 stream 의 `snapshot` frame. */
export function documentSnapshot(
  documents: readonly { documentId: string; parseStatus: string; stale?: boolean }[],
): Record<string, unknown> {
  return {
    type: 'snapshot',
    documents: documents.map((document) => ({
      documentId: document.documentId,
      parseStatus: document.parseStatus,
      stale: document.stale ?? false,
    })),
  };
}

/** content map stream 의 `scan` frame. */
export function scanFrame(
  state: string,
  extra: { finishedAt?: string; ingestedDocuments?: number; error?: string } = {},
): Record<string, unknown> {
  return {
    type: 'scan',
    scan: {
      state,
      gameInstanceId: 9,
      gameInstanceName: 'wordventure-dev',
      requestedAt: '2026-09-04T00:20:00Z',
      finishedAt: extra.finishedAt ?? null,
      ingestedDocuments: extra.ingestedDocuments ?? null,
      error: extra.error ?? null,
    },
  };
}

/** content map stream 의 `ingest` frame. */
export function ingestFrame(
  receivedDocuments: number,
  ingestedDocuments: number,
  failedDocuments = 0,
): Record<string, unknown> {
  return {
    type: 'ingest',
    ingest: { receivedDocuments, ingestedDocuments, failedDocuments },
  };
}

export const FAKE_DOCUMENT_ID = DOCUMENT_ID;
export const FAKE_OBJECT_KEY = OBJECT_KEY;
