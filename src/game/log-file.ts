import crypto from 'node:crypto';
import path from 'node:path';

import { credentialsDir } from '../credentials/paths.js';

/** `~/.artel/logs`(또는 `ARTEL_CONFIG_DIR` 아래 `logs`). credentials 파일과 같은 뿌리를 쓴다. */
export function gameLogDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(credentialsDir(env), 'logs');
}

/**
 * launch 한 번마다 새 파일 하나. Unity 의 `-logFile` 인자로 넘겨 그 실행이 어디에 로그를
 * 남기는지 CLI 가 미리 알게 한다 — 등록이 타임아웃되거나 게임이 일찍 죽었을 때 "어디를
 * 보면 되는지" 를 말할 수 있는 것은 이 값을 CLI 가 직접 정했기 때문이다.
 */
export function generateGameLogPath(env: NodeJS.ProcessEnv = process.env): string {
  const name = `game-${String(Date.now())}-${crypto.randomBytes(6).toString('hex')}.log`;
  return path.join(gameLogDir(env), name);
}
