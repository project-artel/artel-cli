import { dataPaths, defaultDataDir } from './paths.js';
import { isPidAlive, readStateSync } from './state-file.js';

/**
 * desktop app 이 함께 설치한 CLI 가 기본으로 붙을 local stack 의 주소(공유 계약 4절).
 *
 * `ARTEL_RUNTIME_DIR` 이 있을 때만 본다. npm 으로 설치한 CLI 는 이 변수가 없으므로, 그 CLI 의
 * 기본 주소가 기계에 우연히 떠 있는 stack 때문에 바뀌지 않는다. `config.ts` 가 동기 함수라
 * proxy 가 답하는지는 확인하지 않고 supervisor pid 가 살아 있는지만 본다.
 */
export function localStackUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!env.ARTEL_RUNTIME_DIR?.trim()) return null;
  const state = readStateSync(dataPaths(defaultDataDir(env)).stateFile);
  if (state === null || !isPidAlive(state.supervisorPid)) return null;
  return state.url.replace(/\/+$/, '');
}
