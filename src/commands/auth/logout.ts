import { credentialsPath } from '../../credentials/paths.js';
import { readCredential, removeCredential } from '../../credentials/store.js';
import type { LogoutPayload } from '../../output/contract.js';
import { writeJsonPayload, type OutputSink } from '../../output/envelope.js';
import { printLogout } from '../../output/human.js';

export interface AuthLogoutOptions {
  json: boolean;
}

/** 지울 파일이 없어도 `removed: false` 와 exit code 0 이다. idempotent 하다. */
export async function runAuthLogout(
  options: AuthLogoutOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const path = credentialsPath(env);

  // 읽기는 `tokenId` 를 보고에 싣기 위한 것뿐이다. 권한이나 모양이 망가진 파일 때문에
  // 삭제까지 막히면 사용자가 손으로 지우는 수밖에 없어진다.
  const tokenId = await readTokenId(env);

  const removed = await removeCredential(env);
  const payload: LogoutPayload = {
    removed,
    credentialsPath: path,
    tokenId,
    serverSideRevoked: false,
  };

  if (options.json) {
    writeJsonPayload(sink, payload);
    return;
  }
  printLogout(sink, payload);
}

async function readTokenId(env: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    return (await readCredential(env))?.tokenId ?? null;
  } catch {
    return null;
  }
}
