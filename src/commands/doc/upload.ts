import { resolveDocContext } from '../../doc/context.js';
import { uploadDocument, type DocumentUploadEvent } from '../../doc/upload-flow.js';
import { EXIT_FAILURE, EXIT_OK } from '../../exit.js';
import type { FetchLike } from '../../http/client.js';
import type { DocumentUploadPayload } from '../../output/contract.js';
import { writeJsonPayload, type OutputSink } from '../../output/envelope.js';
import { describeDocumentUploadEvent, printDocumentUpload } from '../../output/human.js';

export interface DocUploadCommandOptions {
  json: boolean;
  project: string;
  watch: boolean;
  timeoutSeconds: number;
  apiUrl?: string | undefined;
  /** 테스트가 재연결을 실제 시간으로 기다리지 않게 하는 자리. 평소에는 기본값을 쓴다. */
  reconnectDelaysMs?: readonly number[] | undefined;
}

/**
 * 기획서를 프로젝트에 올린다.
 *
 * **exit code 는 등록이 아니라 요청한 결과를 말한다.** `--watch` 없이 부르면 등록이 곧 결과라
 * 언제나 0 이고, `--watch` 로 추출까지 기다렸는데 `FAILED` 로 끝났으면 1 이다. 그때도 payload 는
 * 그대로 나간다 — 실패한 추출에도 `documentId` 는 있고, 그 값이 있어야 다시 지우거나 조회한다.
 */
export async function runDocUpload(
  filePath: string,
  options: DocUploadCommandOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: FetchLike,
): Promise<number> {
  const context = await resolveDocContext(env, options.apiUrl);

  // 진행 상황은 stderr 로 간다. `--json` 이면 그 자리에 사건 한 줄씩 NDJSON 이 실리고,
  // stdout 에는 끝난 뒤의 payload 한 줄만 남는다 — 다른 명령들과 같은 규칙이다.
  const onEvent = (event: DocumentUploadEvent): void => {
    sink.err(options.json ? JSON.stringify(event) : describeDocumentUploadEvent(event));
  };

  const uploaded = await uploadDocument({
    apiBaseUrl: context.apiBaseUrl,
    cliToken: context.cliToken,
    projectId: options.project,
    filePath,
    watch: options.watch,
    timeoutMs: options.timeoutSeconds * 1_000,
    onEvent,
    fetchImpl,
    reconnectDelaysMs: options.reconnectDelaysMs,
  });

  const payload: DocumentUploadPayload = {
    projectId: options.project,
    documentId: uploaded.document.documentId,
    version: uploaded.document.version,
    fileName: uploaded.document.fileName,
    contentType: uploaded.document.contentType,
    sizeBytes: uploaded.document.sizeBytes,
    uploadedAt: uploaded.document.uploadedAt,
    parseStatus: uploaded.parseStatus,
    stale: uploaded.stale,
    watched: uploaded.watched,
  };

  if (options.json) {
    writeJsonPayload(sink, payload);
  } else {
    printDocumentUpload(sink, payload);
  }

  if (!uploaded.watched) {
    return EXIT_OK;
  }
  return uploaded.parseStatus === 'EXTRACTED' && uploaded.stale !== true ? EXIT_OK : EXIT_FAILURE;
}
